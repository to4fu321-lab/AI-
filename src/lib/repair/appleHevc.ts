// Rebuilds the HEVC decoder configuration (VPS / SPS / PPS) of videos recorded by the iPhone
// camera, for files that lost their index.
//
// iPhones keep the parameter sets only in the index, so they are gone with it. Apple's encoder
// uses the same coding tools across models and iOS versions (checked against an iPhone 12 mini
// on iOS 14 and an iPhone 15 Pro Max on iOS 17: the parameter sets agree field for field apart
// from picture size and the SDR / HDR settings). What is left to find out — picture size and
// SDR (8-bit) or HDR (10-bit) — is settled by test-decoding the first key frame.

import { BitWriter } from "./bits";

export interface AppleHevcVariant {
  /** Display size. */
  width: number;
  height: number;
  /** 10-bit HLG HDR (iPhone 12 and later, "HDR Video" on) or 8-bit SDR. */
  hdr: boolean;
}

const CTB = 32;
/** Apple pads the coded picture to a multiple of 16 luma samples. */
const pad16 = (v: number) => Math.ceil(v / 16) * 16;

function profileTierLevel(w: BitWriter, hdr: boolean, level: number): void {
  w.u(2, 0); // general_profile_space
  w.u(1, 0); // general_tier_flag
  w.u(5, hdr ? 2 : 1); // Main10 / Main
  // general_profile_compatibility_flags: Main also signals Main10 compatibility.
  w.u(32, hdr ? 0x20000000 : 0x60000000);
  w.u(1, 1); // progressive_source
  w.u(1, 0); // interlaced_source
  w.u(1, 1); // non_packed_constraint
  w.u(1, 1); // frame_only_constraint
  w.u(32, 0);
  w.u(12, 0); // 44 reserved bits
  w.u(8, level);
}

function nal(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 2);
  out[0] = type << 1;
  out[1] = 1;
  out.set(body, 2);
  return out;
}

/** general_level_idc for the picture size and frame rate (level × 30, as coded). */
function levelFor(width: number, height: number, fps: number): number {
  const lumaRate = pad16(width) * pad16(height) * Math.max(fps, 30);
  const levels: [number, number][] = [
    [93, 33_177_600], // 3.1
    // 1080p: iPhone 12 writes 4, iPhone 15 writes 4.1; the higher one is safe for both.
    [123, 133_693_440], // 4.1
    [150, 267_386_880], // 5
    [153, 534_773_760], // 5.1
    [156, 1_069_547_520], // 5.2
  ];
  return (levels.find(([, max]) => lumaRate <= max) ?? [183])[0];
}

export function appleVps(v: AppleHevcVariant, fps: number): Uint8Array {
  const w = new BitWriter();
  w.u(4, 0); // vps_video_parameter_set_id
  w.u(1, 1); // vps_base_layer_internal_flag
  w.u(1, 1); // vps_base_layer_available_flag
  w.u(6, 0); // vps_max_layers_minus1
  w.u(3, 0); // vps_max_sub_layers_minus1
  w.u(1, 1); // vps_temporal_id_nesting_flag
  w.u(16, 0xffff);
  profileTierLevel(w, v.hdr, levelFor(v.width, v.height, fps));
  w.u(1, 0); // vps_sub_layer_ordering_info_present_flag
  w.ue(4); // vps_max_dec_pic_buffering_minus1
  w.ue(2); // vps_max_num_reorder_pics
  w.ue(0); // vps_max_latency_increase_plus1
  w.u(6, 0); // vps_max_layer_id
  w.ue(0); // vps_num_layer_sets_minus1
  w.u(1, 0); // vps_timing_info_present_flag
  w.u(1, 0); // vps_extension_flag
  return nal(32, w.finishRbsp());
}

export function appleSps(v: AppleHevcVariant, fps: number): Uint8Array {
  const codedW = pad16(v.width);
  const codedH = pad16(v.height);
  const w = new BitWriter();
  w.u(4, 0); // sps_video_parameter_set_id
  w.u(3, 0); // sps_max_sub_layers_minus1
  w.u(1, 1); // sps_temporal_id_nesting_flag
  profileTierLevel(w, v.hdr, levelFor(v.width, v.height, fps));
  w.ue(0); // sps_seq_parameter_set_id
  w.ue(1); // chroma_format_idc 4:2:0
  w.ue(codedW);
  w.ue(codedH);
  const crop = codedW !== v.width || codedH !== v.height;
  w.u(1, crop ? 1 : 0);
  if (crop) {
    w.ue(0);
    w.ue((codedW - v.width) / 2);
    w.ue(0);
    w.ue((codedH - v.height) / 2);
  }
  const depth = v.hdr ? 2 : 0;
  w.ue(depth); // bit_depth_luma_minus8
  w.ue(depth); // bit_depth_chroma_minus8
  w.ue(7); // log2_max_pic_order_cnt_lsb_minus4
  w.u(1, 0); // sps_sub_layer_ordering_info_present_flag
  w.ue(4);
  w.ue(2);
  w.ue(0);
  w.ue(0); // log2_min_luma_coding_block_size_minus3 (8)
  w.ue(2); // log2_diff_max_min_luma_coding_block_size (CTB 32)
  w.ue(0); // log2_min_luma_transform_block_size_minus2 (4)
  w.ue(3); // log2_diff_max_min_luma_transform_block_size (32)
  w.ue(1); // max_transform_hierarchy_depth_inter
  w.ue(0); // max_transform_hierarchy_depth_intra
  w.u(1, 1); // scaling_list_enabled_flag
  w.u(1, 0); // sps_scaling_list_data_present_flag (default lists)
  w.u(1, 0); // amp_enabled_flag
  w.u(1, 1); // sample_adaptive_offset_enabled_flag
  w.u(1, 0); // pcm_enabled_flag
  w.ue(0); // num_short_term_ref_pic_sets (every slice carries its own)
  w.u(1, 0); // long_term_ref_pics_present_flag
  w.u(1, 1); // sps_temporal_mvp_enabled_flag
  w.u(1, 0); // strong_intra_smoothing_enabled_flag
  w.u(1, 1); // vui_parameters_present_flag
  w.u(1, 0); // aspect_ratio_info_present_flag
  w.u(1, 0); // overscan_info_present_flag
  w.u(1, 1); // video_signal_type_present_flag
  w.u(3, 5); // video_format: unspecified
  w.u(1, 0); // video_full_range_flag
  w.u(1, 1); // colour_description_present_flag
  w.u(8, v.hdr ? 9 : 1); // BT.2020 / BT.709 primaries
  w.u(8, v.hdr ? 18 : 1); // HLG / BT.709 transfer
  w.u(8, v.hdr ? 9 : 1); // matrix
  w.u(1, 0); // chroma_loc_info_present_flag
  w.u(1, 0); // neutral_chroma_indication_flag
  w.u(1, 0); // field_seq_flag
  w.u(1, 0); // frame_field_info_present_flag
  w.u(1, 0); // default_display_window_flag
  w.u(1, 0); // vui_timing_info_present_flag
  w.u(1, 0); // bitstream_restriction_flag
  w.u(1, 0); // sps_extension_present_flag
  return nal(33, w.finishRbsp());
}

export function applePps(v: AppleHevcVariant): Uint8Array {
  const w = new BitWriter();
  w.ue(0); // pps_pic_parameter_set_id
  w.ue(0); // pps_seq_parameter_set_id
  w.u(1, 0); // dependent_slice_segments_enabled_flag
  w.u(1, 0); // output_flag_present_flag
  w.u(3, 0); // num_extra_slice_header_bits
  w.u(1, 0); // sign_data_hiding_enabled_flag
  w.u(1, 0); // cabac_init_present_flag
  w.ue(1); // num_ref_idx_l0_default_active_minus1
  w.ue(0); // num_ref_idx_l1_default_active_minus1
  // init_qp_minus26: Apple uses -QpBdOffset, i.e. -12 for 10-bit.
  w.se(v.hdr ? -12 : 0);
  w.u(1, 0); // constrained_intra_pred_flag
  w.u(1, 0); // transform_skip_enabled_flag
  w.u(1, 1); // cu_qp_delta_enabled_flag
  w.ue(2); // diff_cu_qp_delta_depth
  w.se(0); // pps_cb_qp_offset
  w.se(v.hdr ? -12 : 0); // pps_cr_qp_offset
  w.u(1, 0); // pps_slice_chroma_qp_offsets_present_flag
  w.u(1, 0); // weighted_pred_flag
  w.u(1, 0); // weighted_bipred_flag
  w.u(1, 0); // transquant_bypass_enabled_flag
  w.u(1, 0); // tiles_enabled_flag
  w.u(1, 1); // entropy_coding_sync_enabled_flag (WPP)
  w.u(1, 0); // pps_loop_filter_across_slices_enabled_flag
  w.u(1, 1); // deblocking_filter_control_present_flag
  w.u(1, 0); // deblocking_filter_override_enabled_flag
  w.u(1, 0); // pps_deblocking_filter_disabled_flag
  w.se(0); // pps_beta_offset_div2
  w.se(0); // pps_tc_offset_div2
  w.u(1, 0); // pps_scaling_list_data_present_flag
  w.u(1, 0); // lists_modification_present_flag
  w.ue(0); // log2_parallel_merge_level_minus2
  w.u(1, 0); // slice_segment_header_extension_present_flag
  w.u(1, 0); // pps_extension_present_flag
  return nal(34, w.finishRbsp());
}

/** Picture sizes the iPhone camera records (always stored landscape; rotation is separate). */
export const APPLE_SIZES: [number, number][] = [
  [1920, 1080],
  [3840, 2160],
  [1280, 720],
];

/** Number of CTB rows for a picture height; slices code one entry point per row after the first. */
export function ctbRows(height: number): number {
  return Math.ceil(pad16(height) / CTB);
}

import type { Prober } from "./estimate";

export interface AppleHevcGuess {
  variant: AppleHevcVariant;
  vps: Uint8Array;
  sps: Uint8Array;
  pps: Uint8Array;
}

function annexB(nals: Uint8Array[], body: Uint8Array): Uint8Array {
  const head = nals.reduce((n, x) => n + x.length + 4, 0);
  const out = new Uint8Array(head + body.length);
  let o = 0;
  for (const nal of nals) {
    out[o + 3] = 1;
    out.set(nal, o + 4);
    o += nal.length + 4;
  }
  out.set(body, o);
  return out;
}

/**
 * Drop second-layer NAL units (MV-HEVC spatial video) from Annex-B data: a raw-stream decoder
 * would take them for extra pictures. Only the base layer is needed to check the settings.
 */
export function baseLayerOnly(annexB: Uint8Array): Uint8Array {
  const out = new Uint8Array(annexB.length);
  let o = 0;
  let i = 0;
  const starts: number[] = [];
  for (let k = 0; k + 3 < annexB.length; k++) {
    if (annexB[k] === 0 && annexB[k + 1] === 0 && annexB[k + 2] === 0 && annexB[k + 3] === 1) starts.push(k);
  }
  starts.push(annexB.length);
  for (let n = 0; n + 1 < starts.length; n++) {
    i = starts[n];
    const end = starts[n + 1];
    const layer = ((annexB[i + 4] & 1) << 5) | (annexB[i + 5] >> 3);
    if (layer !== 0) continue;
    out.set(annexB.subarray(i, end), o);
    o += end - i;
  }
  return out.subarray(0, o);
}

/** Share of the picture the decoder actually produced (undecoded chroma stays 0). */
function coverage(yuv: Uint8Array, width: number, height: number): number {
  const from = width * height;
  const to = from + (width * height) / 4;
  let hit = 0;
  let n = 0;
  for (let i = from; i < to; i += 7) {
    n++;
    if (yuv[i] !== 0) hit++;
  }
  return n ? hit / n : 0;
}

/**
 * Find which iPhone settings the frames were encoded with. `key` is the first key frame and
 * `gop` the following frames, all as Annex-B data. Returns null when no setting decodes cleanly
 * (not an iPhone camera recording, or an encoder version that differs).
 */
export async function guessAppleHevc(
  key: Uint8Array,
  gop: Uint8Array,
  gopFrames: number,
  fps: number,
  prober: Prober,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<AppleHevcGuess | null> {
  key = baseLayerOnly(key);
  gop = baseLayerOnly(gop);
  const candidates: AppleHevcVariant[] = [];
  for (const hdr of [false, true]) for (const [width, height] of APPLE_SIZES) candidates.push({ width, height, hdr });
  const clean: AppleHevcGuess[] = [];
  let done = 0;
  for (const variant of candidates) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const guess = { variant, vps: appleVps(variant, fps), sps: appleSps(variant, fps), pps: applePps(variant) };
    const out = await prober.decodeYuv(annexB([guess.vps, guess.sps, guess.pps], key), variant.width, variant.height, 0, "hevc");
    onProgress?.(++done / (candidates.length + 2));
    if (out && !out.errors && coverage(out.data, variant.width, variant.height) > 0.98) clean.push(guess);
  }
  // Confirm on the frames that follow: they exercise inter prediction as well.
  for (const guess of clean) {
    if (gopFrames < 2) return guess;
    const { variant } = guess;
    const out = await prober.decodeYuv(annexB([guess.vps, guess.sps, guess.pps], gop), variant.width, variant.height, gopFrames - 1, "hevc");
    onProgress?.(1);
    if (out && !out.errors) return guess;
  }
  return null;
}
