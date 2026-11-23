import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Archive } from "lucide-react";
export function Picker({
  folder,
  skillArchive = false,
  onPick,
  onNativePick,
}: {
  folder: boolean;
  skillArchive?: boolean;
  onPick: (files: File[]) => void;
  onNativePick?: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null),
    { t } = useTranslation();
  return (
    <>
      <button
        className="picker"
        onClick={() => (onNativePick ? onNativePick() : ref.current?.click())}
      >
        {folder ? <FolderOpen /> : <Archive />}
        {t(
          folder
            ? "chooseFolder"
            : skillArchive
              ? "chooseSkillArchive"
              : "chooseZip",
        )}
      </button>
      <input
        hidden
        type="file"
        ref={ref}
        {...(folder
          ? { webkitdirectory: "", multiple: true }
          : { accept: skillArchive ? ".zip,.skill" : ".zip" })}
        onChange={(e) => {
          if (e.target.files?.length) onPick(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
    </>
  );
}
