import * as React from 'react';
import { X } from 'lucide-react';

// 手機：從底部滑出的面板；電腦：置中的對話框
export function Sheet({ open, title, onClose, children }: {
  open: boolean; title: string; onClose: () => void; children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xl px-5 pt-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200 dark:bg-slate-700 sm:hidden" />
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-black">{title}</h3>
          <button onClick={onClose} aria-label="關閉" className="w-11 h-11 -mr-2 flex items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const inputCls = 'w-full h-12 px-3 rounded-xl text-base font-bold border bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500';
export const labelCls = 'text-xs font-bold mb-1.5 block text-slate-500 dark:text-slate-400';
export const primaryBtn = 'w-full h-12 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-base font-black disabled:opacity-40';
