"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadImage } from "@/lib/image";

type Tool = "pen" | "arrow" | "circle" | "text";

interface Point {
  x: number; // 0..1（画像内の相対座標）
  y: number;
}

interface Stroke {
  tool: Tool;
  color: string;
  width: number; // 画像幅に対する比率
  points: Point[];
  /** tool === "text" のときの文字列 */
  text?: string;
}

const COLORS = [
  { value: "#e02020", label: "赤" },
  { value: "#ffd400", label: "黄" },
  { value: "#1a73e8", label: "青" },
  { value: "#ffffff", label: "白" },
];

const WIDTHS = [
  { value: 0.006, label: "細" },
  { value: 0.013, label: "太" },
];

const TOOLS: { value: Tool; label: string; icon: string }[] = [
  { value: "pen", label: "ペン", icon: "✏️" },
  { value: "arrow", label: "矢印", icon: "↗" },
  { value: "circle", label: "丸", icon: "◯" },
  { value: "text", label: "文字", icon: "Ａ" },
];

/** テキストの文字サイズ（画像幅に対する比率） */
const TEXT_SIZE = 0.045;

/**
 * 写真の上に指で書き込むためのキャンバス。
 * 座標は画像サイズに対する比率で保持するので、表示サイズが変わっても崩れない。
 */
export function PhotoAnnotator({
  src,
  onSave,
  onCancel,
}: {
  src: string;
  onSave: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const drawingRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0].value);
  const [width, setWidth] = useState(WIDTHS[1].value);
  const [textDraft, setTextDraft] = useState<{
    point: Point;
    value: string;
    left: number;
    top: number;
  } | null>(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const stroke of [...strokes, ...(draft ? [draft] : [])]) {
      drawStroke(ctx, stroke, canvas.width, canvas.height);
    }
  }, [strokes, draft]);

  useEffect(() => {
    let cancelled = false;
    loadImage(src).then((image) => {
      if (cancelled) return;
      imageRef.current = image;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    if (ready) redraw();
  }, [ready, redraw]);

  const pointFrom = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const handleDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool === "text") {
      const point = pointFrom(event);
      const canvasRect = event.currentTarget.getBoundingClientRect();
      const stageRect = stageRef.current?.getBoundingClientRect() ?? canvasRect;
      setTextDraft({
        point,
        value: "",
        left: canvasRect.left - stageRect.left + point.x * canvasRect.width,
        top: canvasRect.top - stageRect.top + point.y * canvasRect.height,
      });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    setDraft({ tool, color, width, points: [pointFrom(event)] });
  };

  const confirmText = () => {
    setTextDraft((current) => {
      if (current && current.value.trim()) {
        setStrokes((list) => [
          ...list,
          { tool: "text", color, width, points: [current.point], text: current.value.trim() },
        ]);
      }
      return null;
    });
  };

  const handleMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const point = pointFrom(event);
    setDraft((current) => {
      if (!current) return current;
      const points =
        current.tool === "pen"
          ? [...current.points, point]
          : [current.points[0], point];
      return { ...current, points };
    });
  };

  const handleUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    setDraft((current) => {
      if (current && current.points.length > 1) {
        setStrokes((list) => [...list, current]);
      }
      return null;
    });
  };

  const save = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onSave(canvas.toDataURL("image/jpeg", 0.85));
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <button type="button" onClick={onCancel} className="min-h-11 text-sm font-bold">
          キャンセル
        </button>
        <p className="text-sm font-bold">写真に書き込む</p>
        <button
          type="button"
          onClick={save}
          className="min-h-11 rounded-full bg-brand px-4 text-sm font-bold"
        >
          完了
        </button>
      </div>

      <div ref={stageRef} className="relative flex flex-1 items-center justify-center overflow-hidden px-2">
        <canvas
          ref={canvasRef}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onPointerCancel={handleUp}
          className="max-h-full max-w-full touch-none rounded-lg bg-black/40"
          aria-label="写真に手書きで注釈を追加するキャンバス"
        />
        {textDraft ? (
          <input
            autoFocus
            value={textDraft.value}
            onChange={(event) =>
              setTextDraft((current) =>
                current ? { ...current, value: event.target.value } : current,
              )
            }
            onBlur={confirmText}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                confirmText();
              }
              if (event.key === "Escape") setTextDraft(null);
            }}
            placeholder="文字を入力"
            style={{
              position: "absolute",
              left: textDraft.left,
              top: textDraft.top,
              transform: "translate(-4px, -50%)",
            }}
            className="z-10 min-w-32 rounded-md border-2 border-brand bg-white px-2 py-1 text-sm text-ink outline-none"
          />
        ) : null}
      </div>

      <div className="space-y-3 bg-ink px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1.5">
            {TOOLS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setTool(item.value)}
                aria-pressed={tool === item.value}
                className={`min-h-11 min-w-11 rounded-xl text-base font-bold transition ${
                  tool === item.value ? "bg-brand text-white" : "bg-white/10 text-white/70"
                }`}
              >
                <span aria-hidden>{item.icon}</span>
                <span className="sr-only">{item.label}</span>
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setStrokes((list) => list.slice(0, -1))}
              disabled={strokes.length === 0}
              className="min-h-11 rounded-xl bg-white/10 px-3 text-xs font-bold text-white disabled:opacity-40"
            >
              1つ戻す
            </button>
            <button
              type="button"
              onClick={() => setStrokes([])}
              disabled={strokes.length === 0}
              className="min-h-11 rounded-xl bg-white/10 px-3 text-xs font-bold text-white disabled:opacity-40"
            >
              全消し
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-2">
            {COLORS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setColor(item.value)}
                aria-label={`色：${item.label}`}
                aria-pressed={color === item.value}
                className={`h-11 w-11 rounded-full border-2 transition ${
                  color === item.value ? "border-white scale-110" : "border-white/30"
                }`}
                style={{ background: item.value }}
              />
            ))}
          </div>
          <div className="flex gap-1.5">
            {WIDTHS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setWidth(item.value)}
                aria-pressed={width === item.value}
                className={`min-h-11 rounded-xl px-3 text-xs font-bold transition ${
                  width === item.value ? "bg-brand text-white" : "bg-white/10 text-white/70"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  width: number,
  height: number,
) {
  const px = (point: Point) => ({ x: point.x * width, y: point.y * height });
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = Math.max(2, stroke.width * width);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const points = stroke.points.map(px);
  if (points.length === 0) return;

  if (stroke.tool === "text" && stroke.text) {
    const fontSize = Math.max(16, width * TEXT_SIZE);
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(3, fontSize * 0.12);
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.strokeText(stroke.text, points[0].x, points[0].y);
    ctx.fillStyle = stroke.color;
    ctx.fillText(stroke.text, points[0].x, points[0].y);
    return;
  }

  if (stroke.tool === "pen") {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.stroke();
    return;
  }

  const start = points[0];
  const end = points[points.length - 1];

  if (stroke.tool === "circle") {
    const cx = (start.x + end.x) / 2;
    const cy = (start.y + end.y) / 2;
    const rx = Math.abs(end.x - start.x) / 2;
    const ry = Math.abs(end.y - start.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(rx, 4), Math.max(ry, 4), 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  // 矢印
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();

  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const head = Math.max(12, ctx.lineWidth * 3.2);
  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(
    end.x - head * Math.cos(angle - Math.PI / 7),
    end.y - head * Math.sin(angle - Math.PI / 7),
  );
  ctx.lineTo(
    end.x - head * Math.cos(angle + Math.PI / 7),
    end.y - head * Math.sin(angle + Math.PI / 7),
  );
  ctx.closePath();
  ctx.fill();
}
