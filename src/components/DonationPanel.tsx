import React, { useState, useRef, useEffect } from 'react';

const KOFI_URL = import.meta.env.VITE_KOFI_URL as string | undefined;
const BITCOIN_ADDRESS = import.meta.env.VITE_DONATION_BITCOIN_ADDRESS as string | undefined;

const COPIED_FEEDBACK_MS = 1500;

export function DonationPanel() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const hasKofi = typeof KOFI_URL === 'string' && KOFI_URL.trim() !== '';
  const hasBitcoin = typeof BITCOIN_ADDRESS === 'string' && BITCOIN_ADDRESS.trim() !== '';
  const hasAny = hasKofi || hasBitcoin;

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(id);
  }, [copied]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const el = panelRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleCopy = async () => {
    if (!BITCOIN_ADDRESS) return;
    try {
      await navigator.clipboard.writeText(BITCOIN_ADDRESS);
      setCopied(true);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  if (!hasAny) return null;

  return (
    <div className="hud-donation" ref={panelRef}>
      <button
        type="button"
        className="hud-donation-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Support / Donate"
      >
        <span className="hud-donation-btn-icon" aria-hidden>♥</span>
        <span className="hud-donation-btn-text">Support</span>
      </button>
      {open && (
        <div className="hud-donation-panel">
          <div className="hud-donation-panel-inner">
            {hasKofi && (
              <p className="hud-donation-row">
                <a
                  href={KOFI_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hud-donation-link"
                >
                  Support on Ko-fi
                </a>
              </p>
            )}
            {hasBitcoin && (
              <div className="hud-donation-row">
                <span className="hud-donation-label">Bitcoin</span>
                <div className="hud-donation-address-wrap">
                  <code className="hud-donation-address">{BITCOIN_ADDRESS}</code>
                  <button
                    type="button"
                    className="hud-donation-copy"
                    onClick={handleCopy}
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
            <button
              type="button"
              className="hud-donation-close"
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
