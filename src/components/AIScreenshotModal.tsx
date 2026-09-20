import React, { useState, useEffect, useRef } from 'react';
import { 
  Camera, 
  Upload, 
  Sparkles, 
  X, 
  Check, 
  Trash2, 
  Plus, 
  Loader2, 
  AlertCircle, 
  Image as ImageIcon,
  CheckCircle2,
  HelpCircle
} from 'lucide-react';

export interface ParsedStockItem {
  symbol: string;
  name: string;
  shares: number;
  cost: number | null;
  currentPrice?: number | null;
  selected: boolean;
}

export interface UnresolvedStockItem {
  name: string;
  shares: number;
  cost: number | null;
  totalCost: number | null;
}

export interface InvalidStockItem {
  symbol?: string;
  name: string;
  shares: number;
  cost: number | null;
  totalCost: number | null;
  expectedTotal: number;
}

interface AIScreenshotModalProps {
  isOpen: boolean;
  onClose: () => void;
  darkMode: boolean;
  authenticatedFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onApplyStocks: (
    stocksToApply: { symbol: string; name: string; shares: number; cost: number | null }[],
    mode: 'merge' | 'replace' | 'add'
  ) => Promise<void>;
}

export const AIScreenshotModal: React.FC<AIScreenshotModalProps> = ({
  isOpen,
  onClose,
  darkMode,
  authenticatedFetch,
  onApplyStocks
}) => {
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string>('image/png');
  const [isParsing, setIsParsing] = useState<boolean>(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsedList, setParsedList] = useState<ParsedStockItem[]>([]);
  const [unresolvedList, setUnresolvedList] = useState<UnresolvedStockItem[]>([]);
  const [invalidList, setInvalidList] = useState<InvalidStockItem[]>([]);
  const [importMode, setImportMode] = useState<'merge' | 'replace' | 'add'>('merge');
  const [isApplying, setIsApplying] = useState<boolean>(false);
  const [successNote, setSuccessNote] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      setImageBase64(null);
      setParseError(null);
      setParsedList([]);
      setUnresolvedList([]);
      setInvalidList([]);
      setIsParsing(false);
      setSuccessNote(null);
    }
  }, [isOpen]);

  // Listen to Paste event (Ctrl+V / Cmd+V)
  useEffect(() => {
    if (!isOpen) return;

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            handleFileSelect(file);
            break;
          }
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleFileSelect = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setParseError('請選擇圖片檔案 (PNG, JPG, WEBP 等)');
      return;
    }

    setParseError(null);
    setSuccessNote(null);
    setMimeType(file.type || 'image/png');

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      setImageBase64(result);
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleStartParsing = async () => {
    if (!imageBase64) return;

    setIsParsing(true);
    setParseError(null);
    setSuccessNote(null);

    try {
      const res = await authenticatedFetch('/api/parse-portfolio-screenshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          imageBase64,
          mimeType
        })
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || '解析失敗，請重新嘗試');
      }

      const items: ParsedStockItem[] = (data.parsedStocks || []).map((s: any) => ({
        symbol: (s.symbol || '').toString().trim().toUpperCase(),
        name: (s.name || s.symbol || '').toString().trim(),
        shares: Math.max(0, Number(s.shares) || 0),
        cost: s.cost !== null && s.cost !== undefined && !isNaN(Number(s.cost)) ? Number(s.cost) : null,
        currentPrice: s.currentPrice ? Number(s.currentPrice) : null,
        selected: true
      }));

      const unresolved: UnresolvedStockItem[] = data.unresolved || [];
      const invalid: InvalidStockItem[] = data.invalid || [];

      if (items.length === 0 && unresolved.length === 0 && invalid.length === 0) {
        setParseError('未能從圖片中辨識出有效的股票資料，請嘗試上傳更清晰的券商畫面。');
        setParsedList([]);
        setUnresolvedList([]);
        setInvalidList([]);
      } else {
        setParsedList(items);
        setUnresolvedList(unresolved);
        setInvalidList(invalid);

        let noteStr = `成功辨識出 ${items.length} 檔持股！`;
        const extraParts: string[] = [];
        if (unresolved.length > 0) extraParts.push(`${unresolved.length} 檔未對照代號`);
        if (invalid.length > 0) extraParts.push(`${invalid.length} 檔數字檢核不符`);
        if (extraParts.length > 0) {
          noteStr += `（另有 ${extraParts.join('、')}）`;
        }
        setSuccessNote(noteStr);
      }
    } catch (err: any) {
      console.error('OCR Parsing Error:', err);
      setParseError(err.message || 'AI 辨識發生錯誤，請稍後再試。');
    } finally {
      setIsParsing(false);
    }
  };

  const handleItemChange = (index: number, field: keyof ParsedStockItem, value: any) => {
    setParsedList(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleRemoveItem = (index: number) => {
    setParsedList(prev => prev.filter((_, i) => i !== index));
  };

  const handleAddEmptyRow = () => {
    setParsedList(prev => [
      ...prev,
      { symbol: '', name: '', shares: 1000, cost: null, selected: true }
    ]);
  };

  const handleSelectAll = (checked: boolean) => {
    setParsedList(prev => prev.map(item => ({ ...item, selected: checked })));
  };

  const handleConfirmApply = async () => {
    const validSymbolRegex = /^[A-Za-z0-9]+$/;
    const selectedItems = parsedList.filter(item => item.selected && validSymbolRegex.test(item.symbol.trim()) && item.shares > 0);
    if (selectedItems.length === 0) {
      setParseError('請至少勾選並保留一檔有效的股票（代號需為英數字）與股數');
      return;
    }

    setIsApplying(true);
    try {
      await onApplyStocks(
        selectedItems.map(item => ({
          symbol: item.symbol.trim().toUpperCase(),
          name: item.name.trim(),
          shares: Number(item.shares),
          cost: item.cost !== null && item.cost > 0 ? Number(item.cost) : null
        })),
        importMode
      );
      onClose();
    } catch (err: any) {
      setParseError(err.message || '更新持股失敗，請稍後再試');
    } finally {
      setIsApplying(false);
    }
  };

  const allSelected = parsedList.length > 0 && parsedList.every(i => i.selected);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
      <div 
        className={`relative w-full max-w-2xl rounded-2xl shadow-2xl border transition-all my-auto overflow-hidden ${
          darkMode ? 'bg-slate-900 border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-800'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${
          darkMode ? 'border-slate-800 bg-slate-900/90' : 'border-slate-100 bg-slate-50/50'
        }`}>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 text-white shadow-md">
              <Camera className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-extrabold text-base flex items-center gap-1.5">
                AI 券商截圖辨識匯入
                <Sparkles className="w-4 h-4 text-amber-400" />
              </h3>
              <p className="text-xs text-slate-400">
                上傳或直接貼上券商 APP 庫存畫面，AI 自動判斷代號、股數與均價
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
              darkMode ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar">
          
          {/* Step 1: Upload / Dropzone or Preview */}
          {!imageBase64 ? (
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-6 sm:p-8 text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-3 group ${
                darkMode 
                  ? 'border-slate-700 bg-slate-800/40 hover:bg-slate-800/80 hover:border-indigo-500/80' 
                  : 'border-slate-300 bg-slate-50 hover:bg-indigo-50/50 hover:border-indigo-400'
              }`}
            >
              <input 
                ref={fileInputRef}
                type="file" 
                accept="image/*" 
                className="hidden" 
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handleFileSelect(e.target.files[0]);
                  }
                }}
              />
              <div className="p-3.5 rounded-2xl bg-indigo-500/10 text-indigo-500 group-hover:scale-110 transition-transform">
                <Upload className="w-8 h-8" />
              </div>
              <div className="space-y-1">
                <p className="font-bold text-sm">
                  點擊選擇圖片，或拖曳圖片至此處
                </p>
                <p className="text-xs text-slate-400">
                  💡 小技巧：在電腦上按下鍵盤 <span className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 font-mono text-[10px] text-indigo-600 dark:text-indigo-400 font-bold">Ctrl + V</span> 或 <span className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 font-mono text-[10px] text-indigo-600 dark:text-indigo-400 font-bold">Cmd + V</span> 即可直接貼上截圖！
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5 justify-center mt-2">
                {['元大證券', '國泰樹精靈', '富邦 e 點通', '永豐金隨身', '三竹股市', 'Firstrade'].map((broker) => (
                  <span key={broker} className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-200/60 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                    {broker}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Image Preview bar */}
              <div className={`p-3 rounded-xl border flex items-center justify-between gap-3 ${
                darkMode ? 'bg-slate-800/80 border-slate-700' : 'bg-slate-50 border-slate-200'
              }`}>
                <div className="flex items-center gap-3 overflow-hidden">
                  <div className="w-14 h-14 rounded-lg overflow-hidden shrink-0 border border-slate-300 dark:border-slate-700 bg-slate-900">
                    <img src={imageBase64} alt="截圖預覽" className="w-full h-full object-cover" />
                  </div>
                  <div className="truncate">
                    <p className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1">
                      <ImageIcon className="w-3.5 h-3.5 text-indigo-500" />
                      已載入券商截圖
                    </p>
                    <p className="text-[11px] text-slate-400">可以開始進行 Gemini AI 多模態圖片辨識</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => {
                      setImageBase64(null);
                      setParsedList([]);
                      setUnresolvedList([]);
                      setInvalidList([]);
                      setParseError(null);
                      setSuccessNote(null);
                    }}
                    className="px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    重新選擇
                  </button>

                  {parsedList.length === 0 && unresolvedList.length === 0 && invalidList.length === 0 && (
                    <button
                      onClick={handleStartParsing}
                      disabled={isParsing}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-extrabold text-white bg-gradient-to-r from-indigo-600 to-purple-600 hover:opacity-95 shadow-md disabled:opacity-50 cursor-pointer"
                    >
                      {isParsing ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>AI 辨識中...</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-3.5 h-3.5" />
                          <span>開始 AI 辨識</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>

              {/* Parsing Loading Indicator */}
              {isParsing && (
                <div className="p-6 rounded-2xl bg-indigo-50/60 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900/50 text-center space-y-3">
                  <div className="relative inline-block">
                    <div className="w-12 h-12 rounded-full bg-indigo-600/20 text-indigo-600 flex items-center justify-center animate-pulse">
                      <Sparkles className="w-6 h-6 animate-spin" />
                    </div>
                  </div>
                  <div>
                    <p className="font-extrabold text-sm text-indigo-600 dark:text-indigo-300">
                      Gemini 3.6 Vision 多模態 AI 辨識中...
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      正在自動識別代號、股數（張數自動換算 1張=1000股）與成本均價...
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Errors or Notes */}
          {parseError && (
            <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{parseError}</span>
            </div>
          )}

          {successNote && !parseError && (
            <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-emerald-700 dark:text-emerald-300 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-500" />
              <span>{successNote}</span>
            </div>
          )}

          {/* Step 2: Parsed Stocks Result Table and Notifications */}
          {(parsedList.length > 0 || unresolvedList.length > 0 || invalidList.length > 0) && (
            <div className="space-y-4 pt-2">
              {parsedList.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-extrabold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                      <span>辨識結果校對（請確認或微調數據）</span>
                      <span className="px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/60 text-indigo-600 dark:text-indigo-300 text-[10px]">
                        共 {parsedList.length} 檔
                      </span>
                    </h4>

                    <button
                      onClick={handleAddEmptyRow}
                      className="flex items-center gap-1 text-[11px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      新增一列
                    </button>
                  </div>

                  {/* Table */}
                  <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className={`text-[11px] font-bold border-b ${
                        darkMode ? 'bg-slate-800/80 border-slate-800 text-slate-400' : 'bg-slate-100/80 border-slate-200 text-slate-500'
                      }`}>
                        <tr>
                          <th className="p-2.5 w-8 text-center">
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={(e) => handleSelectAll(e.target.checked)}
                              className="rounded text-indigo-600 cursor-pointer"
                            />
                          </th>
                          <th className="p-2.5 w-24">代號</th>
                          <th className="p-2.5">名稱</th>
                          <th className="p-2.5 w-28">股數 (1張=1000)</th>
                          <th className="p-2.5 w-24">成本單價</th>
                          <th className="p-2.5 w-10 text-center">刪除</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                        {parsedList.map((item, index) => (
                          <tr key={index} className={item.selected ? '' : 'opacity-50 bg-slate-50/50 dark:bg-slate-900/30'}>
                            <td className="p-2.5 text-center">
                              <input
                                type="checkbox"
                                checked={item.selected}
                                onChange={(e) => handleItemChange(index, 'selected', e.target.checked)}
                                className="rounded text-indigo-600 cursor-pointer"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={item.symbol}
                                onChange={(e) => handleItemChange(index, 'symbol', e.target.value.toUpperCase())}
                                className={`w-full px-2 py-1 rounded-lg border font-mono font-bold text-xs ${
                                  darkMode ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-300 text-slate-800'
                                }`}
                                placeholder="如: 0056"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={item.name}
                                onChange={(e) => handleItemChange(index, 'name', e.target.value)}
                                className={`w-full px-2 py-1 rounded-lg border text-xs ${
                                  darkMode ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-300 text-slate-800'
                                }`}
                                placeholder="如: 元大高股息"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="number"
                                value={item.shares || ''}
                                onChange={(e) => handleItemChange(index, 'shares', Math.max(0, Number(e.target.value)))}
                                className={`w-full px-2 py-1 rounded-lg border text-xs font-semibold ${
                                  darkMode ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-300 text-slate-800'
                                }`}
                                placeholder="股數"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="number"
                                step="0.01"
                                value={item.cost !== null ? item.cost : ''}
                                onChange={(e) => handleItemChange(index, 'cost', e.target.value ? Number(e.target.value) : null)}
                                className={`w-full px-2 py-1 rounded-lg border text-xs ${
                                  darkMode ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-300 text-slate-800'
                                }`}
                                placeholder="單價成本"
                              />
                            </td>
                            <td className="p-2 text-center">
                              <button
                                onClick={() => handleRemoveItem(index)}
                                className="p-1 text-slate-400 hover:text-red-500 rounded transition-colors cursor-pointer"
                                title="移除此列"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 未能對照代號清單 (純文字) */}
              {unresolvedList.length > 0 && (
                <div className={`p-3.5 rounded-xl border space-y-2 ${
                  darkMode ? 'bg-amber-950/20 border-amber-900/40 text-amber-200' : 'bg-amber-50 border-amber-200 text-amber-900'
                }`}>
                  <div className="flex items-center gap-1.5 font-bold text-xs">
                    <HelpCircle className="w-4 h-4 text-amber-500 shrink-0" />
                    <span>未能自動對照代號（共 {unresolvedList.length} 檔）</span>
                  </div>
                  <p className="text-[11px] opacity-80">
                    💡 以下股票未能自動找到對應的股票代號，若已知代號可使用上方「新增一列」手動新增：
                  </p>
                  <ul className="text-xs space-y-1 list-disc list-inside font-mono">
                    {unresolvedList.map((item, idx) => (
                      <li key={idx}>
                        <span className="font-sans font-semibold">{item.name}</span>: {Number(item.shares || 0).toLocaleString()} 股（均價: {item.cost !== null && item.cost !== undefined ? `$${item.cost}` : '未顯示'}）
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 數字檢核不符清單 (純文字) */}
              {invalidList.length > 0 && (
                <div className={`p-3.5 rounded-xl border space-y-2 ${
                  darkMode ? 'bg-red-950/20 border-red-900/40 text-red-200' : 'bg-red-50 border-red-200 text-red-900'
                }`}>
                  <div className="flex items-center gap-1.5 font-bold text-xs">
                    <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                    <span>數字檢核不符（共 {invalidList.length} 檔）</span>
                  </div>
                  <p className="text-[11px] opacity-80">
                    💡 畫面顯示的投資成本與「股數 × 均價」不符，建議重新上傳或自行核對調整：
                  </p>
                  <ul className="text-xs space-y-1 list-disc list-inside font-mono">
                    {invalidList.map((item, idx) => (
                      <li key={idx}>
                        <span className="font-sans font-semibold">{item.name}</span>
                        {item.symbol ? ` (${item.symbol})` : ''}: 畫面投資成本 {item.totalCost !== null && item.totalCost !== undefined ? `$${item.totalCost.toLocaleString()}` : '未顯示'}，但 股數 × 均價 = ${item.expectedTotal.toLocaleString()}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Import Mode Radio Options */}
              {parsedList.length > 0 && (
                <div className={`p-3.5 rounded-xl border space-y-2 ${
                  darkMode ? 'bg-slate-800/50 border-slate-800' : 'bg-slate-50 border-slate-200'
                }`}>
                  <p className="text-xs font-bold text-slate-600 dark:text-slate-300">
                    匯入寫入方式：
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <label className={`flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer transition-all ${
                      importMode === 'merge' 
                        ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-300 font-bold' 
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}>
                      <input
                        type="radio"
                        name="importMode"
                        checked={importMode === 'merge'}
                        onChange={() => setImportMode('merge')}
                        className="mt-0.5 text-indigo-600"
                      />
                      <div className="text-[11px] leading-tight">
                        <div>覆蓋與更新 (推薦)</div>
                        <div className="text-[10px] opacity-75 font-normal mt-0.5">相同代號覆蓋為最新股數，新代號直接加入</div>
                      </div>
                    </label>

                    <label className={`flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer transition-all ${
                      importMode === 'add' 
                        ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-300 font-bold' 
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}>
                      <input
                        type="radio"
                        name="importMode"
                        checked={importMode === 'add'}
                        onChange={() => setImportMode('add')}
                        className="mt-0.5 text-indigo-600"
                      />
                      <div className="text-[11px] leading-tight">
                        <div>股數累加</div>
                        <div className="text-[10px] opacity-75 font-normal mt-0.5">把截圖的股數加上目前現有的股數</div>
                      </div>
                    </label>

                    <label className={`flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer transition-all ${
                      importMode === 'replace' 
                        ? 'border-red-500 bg-red-50/50 dark:bg-red-950/40 text-red-600 dark:text-red-300 font-bold' 
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}>
                      <input
                        type="radio"
                        name="importMode"
                        checked={importMode === 'replace'}
                        onChange={() => setImportMode('replace')}
                        className="mt-0.5 text-indigo-600"
                      />
                      <div className="text-[11px] leading-tight">
                        <div>清空後重置</div>
                        <div className="text-[10px] opacity-75 font-normal mt-0.5">完全清空原本清單，以此截圖內容為準</div>
                      </div>
                    </label>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className={`flex items-center justify-between px-5 py-3.5 border-t ${
          darkMode ? 'border-slate-800 bg-slate-900/90' : 'border-slate-100 bg-slate-50'
        }`}>
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold rounded-xl text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer"
          >
            取消
          </button>

          {parsedList.length > 0 && (
            <button
              onClick={handleConfirmApply}
              disabled={isApplying || parsedList.filter(i => i.selected).length === 0}
              className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-xs font-extrabold text-white bg-gradient-to-r from-indigo-600 to-purple-600 hover:opacity-95 shadow-lg active:scale-95 disabled:opacity-50 transition-all cursor-pointer"
            >
              {isApplying ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>正在寫入持股資料...</span>
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  <span>確認寫入持股 ({parsedList.filter(i => i.selected).length} 檔)</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
