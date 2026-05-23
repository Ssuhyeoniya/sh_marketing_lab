import { useEffect, useRef } from 'react';

/**
 * Generic confirm dialog. Used by text-delete and area-delete modes so a
 * mis-click can't silently wipe content.
 *
 * Keyboard:
 *   Enter  → 예 (yes)
 *   Esc    → 아니오 (no, dismisses)
 *
 * The Yes button auto-focuses on mount so Enter "just works" without an
 * extra tab. The handler captures keys at the window level (capture phase)
 * to win over the canvas / inline-editor key listeners.
 */
export default function ConfirmDialog({ message, detail, yesLabel = '예', noLabel = '아니오', onYes, onNo }) {
  const yesRef = useRef(null);

  useEffect(() => {
    if (yesRef.current) yesRef.current.focus();
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onYes?.(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onNo?.(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onYes, onNo]);

  return (
    <div className="confirm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onNo?.(); }}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true">
        <div className="confirm-message">{message}</div>
        {detail && <div className="confirm-detail">{detail}</div>}
        <div className="confirm-actions">
          <button
            ref={yesRef}
            type="button"
            className="btn primary"
            onClick={onYes}
          >{yesLabel} <span className="confirm-hint">(Enter)</span></button>
          <button
            type="button"
            className="btn"
            onClick={onNo}
          >{noLabel} <span className="confirm-hint">(Esc)</span></button>
        </div>
      </div>
    </div>
  );
}
