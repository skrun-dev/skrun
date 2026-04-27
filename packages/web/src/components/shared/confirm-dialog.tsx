import { Btn } from "./ui";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: "danger" | "normal";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  variant = "normal",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss is mouse-only by design */}
      <div className="fixed inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">{title}</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">{message}</p>
        <div className="flex gap-3 justify-end">
          <Btn variant="secondary" onClick={onCancel}>
            Cancel
          </Btn>
          <Btn variant={variant === "danger" ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </Btn>
        </div>
      </div>
    </div>
  );
}
