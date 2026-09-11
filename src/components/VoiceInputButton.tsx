"use client";

import { useRef, useState } from "react";

interface SpeechRecognitionResultLike {
  transcript: string;
}

interface SpeechRecognitionResultEvent {
  results: ArrayLike<ArrayLike<SpeechRecognitionResultLike>>;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

/**
 * マイクで話した内容をテキストに変換して渡すボタン。
 * 対応ブラウザがなければ何も表示しない（機能追加が既存の入力を邪魔しないように）。
 */
export function VoiceInputButton({ onResult }: { onResult: (text: string) => void }) {
  const [supported] = useState(
    () =>
      typeof window !== "undefined" &&
      Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
  );
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const toggle = () => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return;

    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const recognition = new Recognition();
    recognition.lang = "ja-JP";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const text = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join("");
      if (text) onResult(text);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={listening}
      aria-label={listening ? "音声入力を止める" : "音声入力する"}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-base transition ${
        listening
          ? "animate-pulse border-danger bg-danger text-white"
          : "border-line bg-surface text-ink-muted"
      }`}
    >
      <span aria-hidden>🎤</span>
    </button>
  );
}
