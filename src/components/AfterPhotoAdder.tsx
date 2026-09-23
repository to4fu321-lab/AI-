"use client";

import { useState } from "react";
import { PhotoField } from "./PhotoField";
import { dataUrlToBlob, putImage } from "@/lib/storage";
import { setAfterImage } from "@/lib/store";

/**
 * Afterの写真を、投稿とは別のタイミングで追加する入口。
 * その場で直せない・自力では直せない・そもそも直すか未定、といった報告のために、
 * 現場（自分の報告）からも管理者（完了報告と同時）からも同じ部品を使う
 */
export function AfterPhotoAdder({
  reportId,
  userId,
  onAdded,
}: {
  reportId: string;
  userId: string;
  onAdded?: () => void;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!value) return;
    setSaving(true);
    try {
      const ref = value.startsWith("data:") ? await putImage(await dataUrlToBlob(value)) : value;
      setAfterImage(reportId, ref, userId);
      setValue(null);
      onAdded?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <PhotoField label="こうなった（After）" hint="任意" value={value} onChange={setValue} />
      {value ? (
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="btn btn-primary w-full"
        >
          {saving ? "保存中…" : "この写真を追加する"}
        </button>
      ) : null}
    </div>
  );
}
