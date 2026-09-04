import { useRef, useState } from "react";
import { IconPhoto, IconUpload, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  LikedCoverArt,
  LIKED_COVERS,
  LIKED_COVER_ORDER,
} from "@/components/shared/liked-cover";
import { useLikedCoverStore } from "@/lib/store/liked-cover";
import { cn } from "@/lib/utils";

/** Side of the square the uploaded picture is baked down to. */
const COVER_SIZE = 512;

/**
 * Re-encode whatever the user picked as a 512px square JPEG data URL:
 * centre-cropped like `object-fit: cover`, so a wide photo doesn't
 * squash. The result lands in local storage (~150 KB), where the
 * original file — often several megabytes — would not fit.
 */
async function toCoverDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = COVER_SIZE;
    canvas.height = COVER_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    const scale = Math.max(
      COVER_SIZE / bitmap.width,
      COVER_SIZE / bitmap.height,
    );
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.drawImage(bitmap, (COVER_SIZE - w) / 2, (COVER_SIZE - h) / 2, w, h);
    return canvas.toDataURL("image/jpeg", 0.88);
  } finally {
    bitmap.close();
  }
}

const OPTION =
  "flex cursor-pointer flex-col items-center gap-1.5 rounded-[9px] px-2 pb-1.5 pt-2 transition-colors duration-[140ms] hover:bg-w060";

/**
 * The cover picker for Liked songs: the four covers from the design,
 * plus a picture of the user's own.
 *
 * Sits on the hero artwork as a button that only shows on hover, so the
 * page reads as artwork until you go looking for the control. The panel
 * is a popover rather than a menu because a 4-up grid of swatches is not
 * a list of rows, and menu keyboard semantics would fight it.
 */
export function LikedCoverPicker({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const preset = useLikedCoverStore((s) => s.preset);
  const custom = useLikedCoverStore((s) => s.custom);
  const setPreset = useLikedCoverStore((s) => s.setPreset);
  const setCustom = useLikedCoverStore((s) => s.setCustom);
  const clearCustom = useLikedCoverStore((s) => s.clearCustom);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setCustom(await toCoverDataUrl(file));
    } catch {
      toast.error("Couldn't use that image");
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Change cover"
          title="Change cover"
          className={cn(
            "absolute right-2 top-2 z-10 grid size-7 cursor-pointer place-items-center rounded-lg",
            "bg-w140 text-t2 backdrop-blur-[8px] transition-[opacity,background-color] duration-[160ms]",
            "hover:bg-w240 focus-visible:opacity-100",
            // Hidden until the artwork is hovered, and while the header
            // is collapsed, where the cover is scaled down to a thumbnail
            // and the button would ride along at a third of its size.
            "opacity-0 group-hover/cover:opacity-100 data-[state=open]:opacity-100",
            "group-data-[compact=true]/cover:pointer-events-none group-data-[compact=true]/cover:opacity-0!",
            className,
          )}
        >
          <IconPhoto className="size-[15px]" stroke={1.8} />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[268px] rounded-[12px] border-w100 bg-glass3 p-2.5 shadow-[0_18px_40px_-12px_var(--k850)] backdrop-blur-[22px] backdrop-saturate-[1.4]"
      >
        <div className="px-1 pb-2 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-t4">
          Playlist cover
        </div>

        <div className="grid grid-cols-4 gap-1">
          {LIKED_COVER_ORDER.map((key) => {
            const on = !custom && preset === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setPreset(key)}
                className={cn(OPTION, on && "bg-w070 hover:bg-w070")}
              >
                <LikedCoverArt
                  art={LIKED_COVERS[key]}
                  className="size-[46px] rounded-lg"
                  heart={52}
                />
                <span
                  className={cn("text-[10.5px]", on ? "text-t1" : "text-t6")}
                >
                  {LIKED_COVERS[key].label}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-2 flex flex-col gap-1 border-t border-w070 pt-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              // Let the same file be picked again after a removal.
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex cursor-pointer items-center gap-2.5 rounded-[9px] border border-dashed border-w180 bg-w060 px-2.5 py-2.5 text-[13px] font-medium text-t2 transition-colors duration-[140ms] hover:border-w300 hover:bg-w110"
          >
            <IconUpload className="size-[15px]" stroke={1.8} />
            {custom ? "Replace image" : "Upload image"}
          </button>
          {custom ? (
            <button
              type="button"
              onClick={() => clearCustom()}
              className="flex cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[12.5px] text-t6 transition-colors duration-[140ms] hover:bg-w060 hover:text-t3"
            >
              <IconX className="size-3.5" stroke={1.9} />
              Remove uploaded image
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
