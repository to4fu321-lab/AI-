// Repair for files whose index (moov) survived but no longer matches the data: downloads or
// copies that stopped early, blocks that were overwritten with zeros or garbage, files that
// lost bytes at the front. Every sample the index lists is checked against the file; the ones
// that are really there are kept with their original timing, the rest is cut out cleanly.

import { parseAacFrame } from "./aac";
import { readTracks, type InTrack, type OutTrack } from "./mp4";
import { Reader } from "./scan";
import { hasZeroRun } from "./zeros";

export interface TrackReport {
  kind: "vide" | "soun";
  format: string;
  total: number;
  /** Samples that lie (partly) beyond the end of the file. */
  missing: number;
  /** Samples inside the file whose bytes are not what the index says. */
  corrupt: number;
  /** Intact samples that had to go because they depend on a lost frame. */
  undecodable: number;
  kept: number;
}

export interface IndexRepair {
  tracks: OutTrack[];
  reports: TrackReport[];
  /** Bytes by which every position in the index was off (data removed or added in front). */
  shift: number;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
}

type Checker = (buf: Uint8Array, at: number, size: number) => boolean;

/** Build a content check for a track's samples from its sample entry. */
function checkerFor(t: InTrack): { check: Checker; strong: boolean } {
  const cfg = (name: string): Uint8Array | null => {
    for (let i = 86; i + 8 <= t.entry.length; ) {
      const size = ((t.entry[i] << 24) | (t.entry[i + 1] << 16) | (t.entry[i + 2] << 8) | t.entry[i + 3]) >>> 0;
      if (size < 8) break;
      if (String.fromCharCode(...t.entry.subarray(i + 4, i + 8)) === name) return t.entry.subarray(i + 8, i + size);
      i += size;
    }
    return null;
  };
  const h264 = ["avc1", "avc3"].includes(t.format);
  const hevc = ["hvc1", "hev1", "dvh1", "dvhe"].includes(t.format);
  if (t.kind === "vide" && (h264 || hevc)) {
    const c = cfg(h264 ? "avcC" : "hvcC");
    const lengthSize = c ? ((h264 ? c[4] : c[21]) & 3) + 1 : 4;
    // A video sample is a chain of length-prefixed NAL units that must end exactly at the
    // sample's end. Only the part inside the buffer can be walked; that is enough to tell
    // real data from zeros or noise.
    return {
      strong: true,
      check: (buf, at, size) => {
        let p = 0;
        let nals = 0;
        while (p + lengthSize < size && at + p + lengthSize < buf.length) {
          let len = 0;
          for (let k = 0; k < lengthSize; k++) len = len * 256 + buf[at + p + k];
          if (len === 0 || p + lengthSize + len > size) return false;
          if (buf[at + p + lengthSize] & 0x80) return false; // forbidden_zero_bit
          p += lengthSize + len;
          nals++;
        }
        if (nals === 0 || !(p === size || at + p + lengthSize >= buf.length)) return false;
        return !hasZeroRun(buf, at, Math.min(buf.length, at + size));
      },
    };
  }
  if (t.kind === "soun" && t.format === "mp4a") {
    // Raw AAC-LC: the frame must parse to exactly the size the index gives.
    const i = (() => {
      for (let k = 8; k + 4 < t.entry.length; k++) {
        if (t.entry[k] === 0x65 && String.fromCharCode(...t.entry.subarray(k, k + 4)) === "esds") return k;
      }
      return -1;
    })();
    let srIndex = -1;
    if (i >= 0) {
      for (let o = i + 8; o + 4 < t.entry.length; o++) {
        // DecoderSpecificInfo: tag 5, length, AudioSpecificConfig
        if (t.entry[o] === 5) {
          let q = o + 1;
          while (t.entry[q] & 0x80) q++;
          const asc0 = t.entry[q + 1];
          const asc1 = t.entry[q + 2];
          if (asc0 >> 3 === 2) srIndex = ((asc0 & 7) << 1) | (asc1 >> 7);
          break;
        }
      }
    }
    if (srIndex >= 0 && srIndex <= 12) {
      return {
        strong: true,
        check: (buf, at, size) => parseAacFrame(buf, at, Math.min(buf.length, at + size), srIndex, true)?.length === size,
      };
    }
  }
  if (t.kind === "vide") {
    // Unknown video codec: at least rule out blocks of zeros.
    return { strong: false, check: (buf, at, size) => buf.subarray(at, at + Math.min(size, 64)).some((b) => b !== 0) };
  }
  // Other audio (PCM ...): silence is legitimately all zeros, so only the position is checked.
  return { strong: false, check: () => true };
}

async function validate(blob: Blob, t: InTrack, shift: number, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  // 0 = fine, 1 = beyond the end of the file, 2 = corrupt
  const state = new Uint8Array(t.sizes.length);
  const { check } = checkerFor(t);
  const reader = new Reader(blob, blob.size);
  const n = Math.min(t.sizes.length, limit);
  for (let i = 0; i < n; i++) {
    if ((i & 1023) === 0) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if ((i & 16383) === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const pos = t.offsets[i] + shift;
    const size = t.sizes[i];
    if (pos < 0 || size === 0) {
      state[i] = 2;
      continue;
    }
    if (pos + size > blob.size) {
      state[i] = 1;
      continue;
    }
    let v = reader.view(pos) ?? (await reader.load(pos));
    // Have the whole sample in the buffer when it fits, so that its payload can be inspected.
    if (v.at + size > v.buf.length && size < 6 * 1024 * 1024) v = await reader.load(pos);
    if (!check(v.buf, v.at, size)) state[i] = 2;
  }
  return state;
}

/**
 * When most samples fail their check although the file is long enough, the data probably moved:
 * bytes were lost (or added) in front of it. Look around the indexed position of a few samples
 * for the place where a NAL chain of exactly their size starts, and take the common distance.
 */
async function findShift(blob: Blob, video: InTrack, signal?: AbortSignal): Promise<number | null> {
  const { check } = checkerFor(video);
  const RANGE = 2 * 1024 * 1024;
  const votes = new Map<number, number>();
  const n = video.sizes.length;
  const picks = [...new Set([0.2, 0.35, 0.5, 0.65, 0.8].map((f) => Math.floor(n * f)))];
  for (const i of picks) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const size = video.sizes[i];
    if (size < 64) continue;
    const from = Math.max(0, video.offsets[i] - RANGE);
    const buf = new Uint8Array(await blob.slice(from, Math.min(blob.size, video.offsets[i] + RANGE + size)).arrayBuffer());
    for (let at = 0; at + size <= buf.length; at++) {
      // Cheap pre-check on the first length field before walking the chain.
      if (buf[at] > 3) continue;
      if (!check(buf, at, size)) continue;
      const shift = from + at - video.offsets[i];
      votes.set(shift, (votes.get(shift) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  let bestVotes = 1;
  for (const [shift, count] of votes) {
    if (shift !== 0 && count > bestVotes) {
      bestVotes = count;
      best = shift;
    }
  }
  return best;
}

/** Try to repair using the file's own index. Returns null when the index is not usable. */
export async function repairFromIndex(
  blob: Blob,
  moov: Uint8Array,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<IndexRepair | null> {
  const all = readTracks(moov);
  const video = all.find((t) => t.kind === "vide");
  if (!video) return null;
  // One video track and the audio tracks: other track types are not carried over.
  const tracks = [video, ...all.filter((t) => t.kind === "soun")];

  let shift = 0;
  let states: Uint8Array[] = [await validate(blob, video, 0, 400, signal)];
  const probed = Math.min(400, video.sizes.length);
  const badStart = states[0].subarray(0, probed).filter((s) => s === 2).length;
  if (checkerFor(video).strong && badStart > probed * 0.5) {
    const found = await findShift(blob, video, signal);
    if (found === null) return null;
    shift = found;
  }

  states = [];
  for (let k = 0; k < tracks.length; k++) {
    states.push(await validate(blob, tracks[k], shift, Infinity, signal));
    onProgress((k + 1) / tracks.length);
  }

  const out: OutTrack[] = [];
  const reports: TrackReport[] = [];
  for (let k = 0; k < tracks.length; k++) {
    const t = tracks[k];
    const state = states[k];
    const n = t.sizes.length;
    const report: TrackReport = { kind: t.kind, format: t.format, total: n, missing: 0, corrupt: 0, undecodable: 0, kept: 0 };
    const offsets: number[] = [];
    const sizes: number[] = [];
    const durations: number[] = [];
    const cts: number[] = [];
    const sync: number[] = [];
    let startDelay = t.startDelay;
    // After a lost video frame nothing decodes correctly until the next key frame.
    let waitForKey = t.kind === "vide" && t.sync !== null;
    for (let i = 0; i < n; i++) {
      const isKey = !t.sync || t.sync[i] === 1;
      let keep = state[i] === 0;
      if (state[i] === 1) report.missing++;
      else if (state[i] === 2) report.corrupt++;
      if (t.kind === "vide" && t.sync) {
        if (!keep) waitForKey = true;
        else if (isKey) waitForKey = false;
        else if (waitForKey) {
          keep = false;
          report.undecodable++;
        }
      }
      if (keep) {
        offsets.push(t.offsets[i] + shift);
        sizes.push(t.sizes[i]);
        durations.push(t.durations[i]);
        if (t.cts) cts.push(t.cts[i]);
        sync.push(isKey ? 1 : 0);
      } else if (state[i] !== 1) {
        // Keep the timeline intact: the time of a dropped sample goes to the one before it
        // (a held frame / a moment of silence), or in front of the track.
        if (durations.length) durations[durations.length - 1] += t.durations[i];
        else startDelay += t.durations[i];
      }
    }
    report.kept = sizes.length;
    reports.push(report);
    // When most of a track inside the file fails its check, the index itself is wrong for that
    // track; scanning the data will do better than trusting it.
    const present = n - report.missing;
    if (checkerFor(t).strong && present > 20 && report.corrupt > present * 0.5) return null;
    if (!sizes.length) {
      if (t.kind === "vide") return null;
      continue;
    }
    out.push({
      kind: t.kind,
      entry: t.entry,
      timescale: t.timescale,
      matrix: t.matrix,
      width: t.width,
      height: t.height,
      offsets,
      sizes,
      durations,
      cts: t.cts ? cts : null,
      sync: t.sync ? sync : null,
      mediaTime: t.mediaTime,
      startDelay,
    });
  }

  const v = out[0];
  let ticks = 0;
  for (const d of v.durations as number[]) ticks += d;
  const typical = (v.durations as number[]).slice().sort((a, b) => a - b)[Math.floor(v.durations.length / 2)] || 1;
  return {
    tracks: out,
    reports,
    shift,
    width: (video.entry[32] << 8) | video.entry[33],
    height: (video.entry[34] << 8) | video.entry[35],
    fps: Math.round((video.timescale / typical) * 100) / 100,
    durationSeconds: (v.startDelay + ticks) / v.timescale,
  };
}
