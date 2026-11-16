import * as React from 'react';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  Plus, 
  Trash2, 
  Calendar as CalendarIcon, 
  RefreshCw, 
  TrendingUp, 
  DollarSign, 
  ChevronLeft, 
  ChevronRight,
  Search,
  Loader2,
  AlertCircle,
  Sun,
  Moon,
  LogOut,
  LogIn,
  User as UserIcon,
  Settings,
  ChevronDown,
  ChevronUp,
  PieChart,
  BellRing,
  Send,
  Download,
  MessageSquare,
  ChevronsUpDown,
  Folder,
  Layers,
  Sparkles,
  Clock,
  Camera
} from 'lucide-react';
import { AIScreenshotModal } from './components/AIScreenshotModal';
import { TradeModal } from './components/TradeModal';
import { applyTrade, undoLastTrade, type TradeSide } from '../shared/trades';
import { 
  PieChart as RechartsPieChart, 
  Pie, 
  Cell, 
  ResponsiveContainer, 
  Tooltip, 
  Legend,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  LabelList
} from 'recharts';
import { 
  format, 
  addMonths, 
  subMonths, 
  startOfMonth, 
  endOfMonth, 
  startOfWeek, 
  endOfWeek, 
  isSameMonth, 
  isSameDay, 
  isToday,
  addDays, 
  parseISO,
  isAfter,
  startOfToday
} from 'date-fns';
import { zhTW } from 'date-fns/locale';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
// 移除直接引用伺服器端服務，改用 API 呼叫以避免瀏覽器端編譯錯誤
// import { fetchDividendData } from './services/geminiService';
import { type StockEntry, type CalendarEvent, type DividendInfo, normalizeSymbol, deduplicateStocks } from './types';
import { safeStorage } from './utils/storage';
import { addOneMonth, addDays as shiftDate, computeYearDividends, estimateNetPayment, listDividendEvents, resolveSharesAtExDate, yearsWithDividends, type DividendEventItem, type YearSummary } from '../shared/dividendCalc';
import { Shell, type TabKey } from './ui/Shell';
import { HomeView } from './ui/HomeView';
import { HoldingsView, type HoldingItem } from './ui/HoldingsView';
import { DividendsView } from './ui/DividendsView';
import { AddStockSheet, DeleteStockSheet, SettingsSheet } from './ui/Sheets';
import { 
  auth, 
  db, 
  loginWithGoogle, 
  logout, 
  onAuthStateChanged, 
  User,
  OperationType,
  handleFirestoreError
} from './firebase';
import { 
  collection, 
  doc, 
  setDoc, 
  deleteDoc, 
  onSnapshot, 
  query, 
  updateDoc,
  serverTimestamp,
  getDoc
} from 'firebase/firestore';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const authenticatedFetch = async (url: string, options: RequestInit = {}) => {
  const user = auth.currentUser;
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {})
  };
  if (user) {
    try {
      const token = await user.getIdToken();
      headers['Authorization'] = `Bearer ${token}`;
    } catch (e) {
      console.warn('Failed to get auth token:', e);
    }
  }
  return fetch(url, { ...options, headers });
};

const formatUpdatedAt = (updatedAt: any) => {
  if (!updatedAt) return null;
  try {
    let d: Date;
    if (typeof updatedAt === 'string') {
      d = new Date(updatedAt);
    } else if (updatedAt && typeof updatedAt.toDate === 'function') {
      d = updatedAt.toDate();
    } else if (updatedAt instanceof Date) {
      d = updatedAt;
    } else {
      d = new Date(updatedAt);
    }
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString('zh-TW', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  } catch (e) {
    return null;
  }
};

export default function App() {
  return <MainApp />;
}

function MainApp() {
  const [stocks, setStocks] = useState<StockEntry[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [newSymbol, setNewSymbol] = useState('');
  const [newShares, setNewShares] = useState<number>(0);
  const [newCost, setNewCost] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshingStocks, setRefreshingStocks] = useState<Set<string>>(new Set());
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => {
    const saved = safeStorage.getItem('dividend_notifications_enabled');
    return saved !== 'false'; // Defaults to true
  });
  const [darkMode, setDarkMode] = useState(() => {
    const saved = safeStorage.getItem('dividend_dark_mode');
    return saved === 'true';
  });
  const [selectedYear, setSelectedYear] = useState<number>(() => new Date().getFullYear());
  const [hasAutoRefreshed, setHasAutoRefreshed] = useState(false);
  const [cash, setCash] = useState<number>(0);
  const [telegramBotToken, setTelegramBotToken] = useState(() => {
    return safeStorage.getItem('telegram_bot_token') || '';
  });
  const [telegramChatId, setTelegramChatId] = useState(() => {
    return safeStorage.getItem('telegram_chat_id') || '';
  });
  const [isSendingTelegram, setIsSendingTelegram] = useState(false);
  const [isScreenshotModalOpen, setIsScreenshotModalOpen] = useState(false);

  const [snapshots, setSnapshots] = useState<{ date: string; stocks?: any[]; cash?: number; totalValue?: number }[]>([]);
  const [stockToDelete, setStockToDelete] = useState<{ symbol: string; name: string } | null>(null);
  const [tradeModal, setTradeModal] = useState<{ symbol: string; side: TradeSide } | null>(null);






  // Load historical snapshots for accurate ex-dividend date share calculation
  useEffect(() => {
    if (!isAuthReady || !user) {
      setSnapshots([]);
      return;
    }
    const snapshotsRef = collection(db, 'users', user.uid, 'snapshots');
    const unsubscribe = onSnapshot(snapshotsRef, (snapshot) => {
      const list = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          date: data.date || doc.id,
          stocks: Array.isArray(data.stocks) ? data.stocks : undefined,
          cash: data.cash !== undefined && data.cash !== null ? Number(data.cash) : undefined,
          totalValue: data.totalValue !== undefined && data.totalValue !== null ? Number(data.totalValue) : undefined,
        };
      });
      list.sort((a, b) => a.date.localeCompare(b.date));
      setSnapshots(list);
    }, (err) => {
      console.warn('[Snapshots] Warning:', err);
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  // Automatically record/update snapshot for today whenever stocks or cash are updated
  useEffect(() => {
    if (!isAuthReady || !user || !stocks || stocks.length === 0) return;

    const todayStr = format(new Date(), 'yyyy-MM-dd');

    const saveTodaySnapshot = async () => {
      try {
        const snapRef = doc(db, 'users', user.uid, 'snapshots', todayStr);
        const stocksList = stocks.map(s => ({
          symbol: s.symbol,
          name: s.name,
          shares: s.shares,
          cost: s.cost || 0,
          currentPrice: s.dividendInfo?.currentPrice || 0,
          dividendInfo: s.dividendInfo || null
        }));

        const totalStocksValue = stocks.reduce((sum, s) => sum + ((s.dividendInfo?.currentPrice || 0) * s.shares), 0);
        const totalValue = totalStocksValue + cash;

        await setDoc(snapRef, {
          date: todayStr,
          stocks: stocksList,
          cash: cash,
          totalValue: totalValue,
          updatedAt: new Date().toISOString()
        }, { merge: true });
      } catch (err) {
        console.warn('[Snapshot Auto Sync Warning]:', err);
      }
    };

    const timer = setTimeout(() => {
      saveTodaySnapshot();
    }, 1500);

    return () => clearTimeout(timer);
  }, [user, isAuthReady, stocks, cash]);

  // Helper to get exact shares held on or before a given ex-dividend date (exDateStr: YYYY-MM-DD)
  // 除息日前一天的持股（與 Telegram 通知共用 shared/dividendCalc.ts 的規則）
  const getSharesOnExDate = useCallback((symbol: string, exDateStr: string, currentShares: number): number => {
    if (!exDateStr) return currentShares;
    const trades = stocks.find(s => normalizeSymbol(s.symbol) === normalizeSymbol(symbol))?.trades || [];
    return resolveSharesAtExDate(snapshots, symbol, exDateStr, currentShares, trades).shares;
  }, [snapshots, stocks]);

  // Notification Helpers (【備註】已由後端 Telegram 推播取代，此為輔助功能)
  const requestNotificationPermission = async () => {
    if (typeof Notification === 'undefined') return;
    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission === 'granted') {
        new Notification('息引力：通知已開啟', {
          body: '太棒了！當有除息或領息事件時，我們會準時提醒您。',
          icon: '/favicon.svg'
        });
      }
    } catch (e) {
      console.warn('Notification permission request not allowed or failed:', e);
    }
  };

  const testNotification = () => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('息引力通知測試', {
          body: '這是一則系統測試通知，代表您的功能運作正常。未來會在當天早上 8:00 提醒您。',
          icon: '/favicon.svg'
        });
        alert('🔔 系統通知已送出，請檢查您的桌面或系統通知！');
      } catch (e) {
        alert('🔔 預覽通知測試：您已啟用除息領息通知！\n\n（提示：由於在特定瀏覽器或 AI Studio 預覽環境中，「系統通知權限」可能受限，若您之後透過手機「加入主畫面」(PWA) 或在獨立分頁中開啟，體驗系統通知會更加完整喔！）');
      }
    } else {
      alert('🔔 預覽通知測試：您已啟用除息領息通知！\n\n（提示：由於在特定瀏覽器或 AI Studio 預覽環境中，「系統通知權限」可能受限，若您之後透過手機「加入主畫面」(PWA) 或在獨立分頁中開啟，體驗系統通知會更加完整喔！）');
    }
  };

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
      
      if (currentUser) {
        const userRef = doc(db, 'users', currentUser.uid);
        setDoc(userRef, {
          uid: currentUser.uid,
          email: currentUser.email,
          displayName: currentUser.displayName,
          photoURL: currentUser.photoURL,
          lastLogin: serverTimestamp()
        }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${currentUser.uid}`));
      }
    });
    return () => unsubscribe();
  }, []);

  // Dark Mode
  useEffect(() => {
    safeStorage.setItem('dividend_dark_mode', darkMode.toString());
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    const themeColorMetas = document.querySelectorAll('meta[name="theme-color"]');
    const color = darkMode ? '#0f172a' : '#ffffff';
    themeColorMetas.forEach(meta => {
      meta.setAttribute('content', color);
    });
  }, [darkMode]);

  // Notifications Enabled State persistence
  useEffect(() => {
    safeStorage.setItem('dividend_notifications_enabled', notificationsEnabled.toString());
  }, [notificationsEnabled]);

  // Firestore Sync
  useEffect(() => {
    if (!isAuthReady) return;

    if (user) {
      const stocksRef = collection(db, 'users', user.uid, 'stocks');
      const unsubscribe = onSnapshot(stocksRef, async (snapshot) => {
        const firestoreStocks = snapshot.docs.map(doc => ({
          ...(doc.data() as StockEntry),
          _docId: doc.id
        }));
        const { uniqueStocks, duplicatesToRemove, mergedSurvivingStocks } = deduplicateStocks(firestoreStocks);
        setStocks(uniqueStocks);

        if (duplicatesToRemove.length > 0) {
          console.log(`[Deduplicate] Found ${duplicatesToRemove.length} duplicate stock docs, updating surviving stocks & cleaning up...`, duplicatesToRemove);
          
          let allMergedSavedSuccessfully = true;
          for (const mergedStock of mergedSurvivingStocks) {
            try {
              const stockRef = doc(db, 'users', user.uid, 'stocks', mergedStock.symbol);
              const payload: any = {
                symbol: mergedStock.symbol,
                name: mergedStock.name,
                shares: mergedStock.shares,
                updatedAt: serverTimestamp()
              };
              if (mergedStock.cost !== undefined && mergedStock.cost !== null) {
                payload.cost = mergedStock.cost;
              }
              if (mergedStock.dividendInfo) {
                payload.dividendInfo = mergedStock.dividendInfo;
              }
              await setDoc(stockRef, payload, { merge: true });
              console.log(`[Deduplicate] Successfully updated surviving stock ${mergedStock.symbol} in Firestore`);
            } catch (saveErr) {
              allMergedSavedSuccessfully = false;
              console.error(`[Deduplicate Error] Failed to update surviving stock ${mergedStock.symbol}:`, saveErr);
            }
          }

          if (allMergedSavedSuccessfully) {
            for (const dupSym of duplicatesToRemove) {
              try {
                await deleteDoc(doc(db, 'users', user.uid, 'stocks', dupSym));
                console.log(`[Deduplicate] Deleted duplicate doc ${dupSym}`);
              } catch (err) {
                console.warn(`Error deleting duplicate stock doc ${dupSym}:`, err);
              }
            }
          } else {
            console.warn(`[Deduplicate Warning] Skipping deletion of duplicate docs because saving merged surviving stocks failed.`);
          }
        }
      }, (err) => {
        handleFirestoreError(err, OperationType.LIST, `users/${user.uid}/stocks`);
      });

      return () => unsubscribe();
    } else {
      const saved = safeStorage.getItem('taiwan_stocks');
      if (saved) {
        try {
          const raw = JSON.parse(saved);
          const { uniqueStocks } = deduplicateStocks(raw);
          setStocks(uniqueStocks);
        } catch (e) {
          console.error('[Storage Error] Failed to parse local taiwan_stocks:', e);
          safeStorage.setItem('taiwan_stocks_corrupted_backup', saved);
          const errorMsg = '偵測到本機持股資料損毀，暫時無法載入，原始資料已備份保留，請聯繫客服或嘗試其他裝置登入查看雲端資料';
          try {
            alert(errorMsg);
          } catch {
            // ignore alert failure if in restricted environment
          }
          setError(errorMsg);
        }
      } else {
        setStocks([]);
      }
    }
  }, [user, isAuthReady]);

  // Cash & Telegram Synced with Firestore or Local Storage
  useEffect(() => {
    if (!isAuthReady) return;

    if (user) {
      const userRef = doc(db, 'users', user.uid);
      const unsubscribe = onSnapshot(userRef, (docSnap) => {
        if (docSnap.exists()) {
          const userData = docSnap.data();
          if (userData.cash !== undefined) {
            setCash(Number(userData.cash));
          } else {
            setCash(0);
          }
          if (userData.telegramBotToken !== undefined && userData.telegramBotToken !== '') {
            setTelegramBotToken(userData.telegramBotToken);
          } else {
            setTelegramBotToken('');
          }
          if (userData.telegramChatId !== undefined && userData.telegramChatId !== '') {
            setTelegramChatId(userData.telegramChatId);
          } else {
            setTelegramChatId('');
          }

        }
      }, (err) => {
        handleFirestoreError(err, OperationType.GET, `users/${user.uid}`);
      });

      return () => unsubscribe();
    } else {
      const savedCash = safeStorage.getItem('taiwan_cash');
      if (savedCash) {
        setCash(Number(savedCash));
      } else {
        setCash(0);
      }
      const savedBotToken = safeStorage.getItem('telegram_bot_token');
      const savedChatId = safeStorage.getItem('telegram_chat_id');
      setTelegramBotToken(savedBotToken || '');
      setTelegramChatId(savedChatId || '');
    }
  }, [user, isAuthReady]);

  // Synchronize Telegram Chat Data with server JSON Database
  useEffect(() => {
    if (!user || !telegramChatId || !telegramBotToken) return;

    const syncChatData = async () => {
      try {
        await authenticatedFetch('/api/telegram/save-chat-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: telegramChatId,
            botToken: telegramBotToken,
            cash: cash,
            stocks: stocks,
            username: user ? (user.displayName || user.email) : '投資大師'
          })
        });
      } catch (e) {
        console.error('Failed to sync Telegram chat data to backend:', e);
      }
    };

    const timer = setTimeout(syncChatData, 1200);
    return () => clearTimeout(timer);
  }, [telegramChatId, telegramBotToken, cash, stocks, user]);

  // Auto-Register Telegram Webhook in background to ensure it always points to the active dev/prod domain
  useEffect(() => {
    if (!user || !telegramBotToken) return;

    const registerWebhook = async () => {
      try {
        const response = await authenticatedFetch('/api/telegram/register-webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            botToken: telegramBotToken,
            baseUrl: window.location.origin
          })
        });
        const data = await response.json();
        if (response.ok && data.success) {
          console.log('🤖 Telegram Webhook automatically registered successfully:', data.description);
        } else {
          console.warn('Telegram Webhook registration issue on boot:', data.error);
        }
      } catch (err) {
        console.error('Failed to auto-register Telegram webhook:', err);
      }
    };

    const timer = setTimeout(registerWebhook, 2000);
    return () => clearTimeout(timer);
  }, [telegramBotToken, user]);

  // Migration
  useEffect(() => {
    if (user && isAuthReady) {
      const saved = safeStorage.getItem('taiwan_stocks');
      if (saved) {
        try {
          const localStocks = JSON.parse(saved) as StockEntry[];
          if (localStocks.length > 0 && stocks.length === 0) {
            localStocks.forEach(async (stock) => {
              const stockRef = doc(db, 'users', user.uid, 'stocks', stock.symbol);
              try {
                await setDoc(stockRef, {
                  ...stock,
                  updatedAt: serverTimestamp()
                });
              } catch (err) {
                console.error("Migration error", err);
              }
            });
            safeStorage.removeItem('taiwan_stocks');
          }
        } catch (e) {
          console.warn(`使用者 ${user.uid} 的本機持股資料損毀，搬移到 Firestore 的流程已跳過`, e);
        }
      }
    }
  }, [user, isAuthReady, stocks.length]);

  // Local Storage fallback
  useEffect(() => {
    if (!user && isAuthReady) {
      safeStorage.setItem('taiwan_stocks', JSON.stringify(stocks));
    }
  }, [stocks, user, isAuthReady]);

  // Intelligent background auto-refresh for stale dividend data
  useEffect(() => {
    if (isAuthReady && stocks.length > 0 && !hasAutoRefreshed && !isLoading) {
      const lastAutoRefresh = safeStorage.getItem('last_auto_dividend_refresh');
      const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
      const isThrottlePassed = !lastAutoRefresh || Number(lastAutoRefresh) < threeHoursAgo;

      const needsRefresh = stocks.some(stock => {
        if (!stock.dividendInfo) return true;
        if (stock.dividendInfo.source === '手動輸入') return false;
        if (!stock.dividendInfo.updatedAt) return true;
        const updateAge = Date.now() - new Date(stock.dividendInfo.updatedAt).getTime();
        // Stale if last updated more than 24 hours ago
        if (updateAge > 24 * 60 * 60 * 1000) return true;
        return false;
      });

      if (needsRefresh && isThrottlePassed) {
        setHasAutoRefreshed(true);
        safeStorage.setItem('last_auto_dividend_refresh', Date.now().toString());
        console.log("Stale dividend data detected. Triggering silent background auto-refresh...");
        handleRefreshAll();
      }
    }
  }, [stocks, isAuthReady, hasAutoRefreshed, isLoading]);


  const handleAddStock = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetSymbol = normalizeSymbol(newSymbol);
    if (!targetSymbol) return;

    setIsLoading(true);
    setError(null);
    try {
      let info: DividendInfo | null = null;
      const cacheRef = doc(db, 'market_data', targetSymbol);
      
      // Check cache first
      try {
        const cacheSnap = await getDoc(cacheRef);
        if (cacheSnap.exists()) {
          const cacheData = cacheSnap.data();
          const updatedAt = cacheData.updatedAt?.toDate();
          const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
          
          if (updatedAt && updatedAt > fourHoursAgo) {
            info = cacheData.info as DividendInfo;
          }
        }
      } catch (e) {
        console.warn(`Cache read error for market_data/${targetSymbol}:`, e);
      }

      if (!info) {
        const response = await authenticatedFetch(`/api/dividend/${encodeURIComponent(targetSymbol)}`);
        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || '查詢失敗');
        }
        info = await response.json();
        
        if (info) {
          try {
            await setDoc(cacheRef, {
              info,
              updatedAt: serverTimestamp()
            });
          } catch (e) {
            console.warn(`Cache write error for market_data/${targetSymbol}:`, e);
          }
        }
      }

      if (info) {
        const cleanSym = normalizeSymbol(info.symbol || targetSymbol);
        const normalizedInfo = { ...info, symbol: cleanSym };
        const stockData: StockEntry = { 
          symbol: cleanSym, 
          name: info.name, 
          shares: newShares || 0, 
          ...(newCost > 0 ? { cost: newCost } : {}),
          dividendInfo: normalizedInfo
        };

        if (user) {
          const stockRef = doc(db, 'users', user.uid, 'stocks', cleanSym);
          try {
            const firestorePayload: any = {
              symbol: cleanSym,
              name: info.name,
              shares: newShares || 0,
              dividendInfo: normalizedInfo,
              updatedAt: serverTimestamp()
            };
            if (newCost > 0) {
              firestorePayload.cost = newCost;
            }
            await setDoc(stockRef, firestorePayload);
          } catch (e) {
            handleFirestoreError(e, OperationType.WRITE, `users/${user.uid}/stocks/${cleanSym}`);
            throw e; // Re-throw to be caught by the outer catch block
          }
        } else {
          const existingIndex = stocks.findIndex(s => normalizeSymbol(s.symbol) === cleanSym);
          if (existingIndex >= 0) {
            const updatedStocks = [...stocks];
            updatedStocks[existingIndex] = stockData;
            setStocks(updatedStocks);
          } else {
            setStocks([...stocks, stockData]);
          }
        }
        setNewSymbol('');
        setNewShares(0);
        setNewCost(0);
        setShowAddForm(false);
      } else {
        setError('找不到該股票的股息資訊，請確認代號是否正確。');
      }
    } catch (err: any) {
      console.error("Add stock error:", err);
      const errorMsg = err?.message || String(err);
      
      if (errorMsg.includes('429') || errorMsg.toLowerCase().includes('rate') || errorMsg.toLowerCase().includes('quota')) {
        setError('Google 搜尋額度已達上限（每日 100 次）。目前無法新增「從未被搜尋過」的股票。請嘗試新增熱門股票（可能已有快取），或明日再試。');
      } else if (errorMsg.includes('Safety') || errorMsg.includes('blocked')) {
        setError('查詢被系統過濾器攔截，請稍後再試或換一個代號。');
      } else {
        setError(`查詢失敗: ${errorMsg.length > 50 ? errorMsg.substring(0, 50) + '...' : errorMsg}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleApplyScreenshotStocks = async (
    parsedItems: { symbol: string; name: string; shares: number; cost: number | null }[],
    mode: 'merge' | 'replace' | 'add'
  ) => {
    setIsLoading(true);
    try {
      const currentStocks = [...stocks];
      let workingStocksList = [...stocks];

      const successfulItems: { symbol: string; name: string; entry: StockEntry }[] = [];
      const failedItems: { symbol: string; error: string }[] = [];

      for (const item of parsedItems) {
        const symbol = normalizeSymbol(item.symbol);
        if (!symbol) continue;

        if (!/^[A-Za-z0-9]+$/.test(symbol)) {
          failedItems.push({
            symbol: item.symbol || '未知代號',
            error: `股票代號格式不合法（"${symbol}" 包含無效字元，僅允許英數字）`
          });
          continue;
        }

        let existingStock = workingStocksList.find(s => normalizeSymbol(s.symbol) === symbol);
        let dividendInfo: DividendInfo | null = existingStock?.dividendInfo || null;

        if (!dividendInfo) {
          try {
            const cacheRef = doc(db, 'market_data', symbol);
            const cacheSnap = await getDoc(cacheRef);
            if (cacheSnap.exists() && cacheSnap.data()?.info) {
              dividendInfo = cacheSnap.data().info;
            } else {
              const res = await authenticatedFetch(`/api/dividend/${encodeURIComponent(symbol)}`);
              if (res.ok) {
                dividendInfo = await res.json();
                if (dividendInfo) {
                  await setDoc(cacheRef, { info: dividendInfo, updatedAt: serverTimestamp() }).catch(console.warn);
                }
              }
            }
          } catch (e) {
            console.warn(`Could not fetch dividend info for OCR stock ${symbol}:`, e);
          }
        }

        let finalShares = item.shares;
        if (mode === 'add' && existingStock) {
          finalShares += existingStock.shares;
        }

        const finalCost = item.cost !== null && item.cost > 0 ? item.cost : (existingStock?.cost || undefined);
        const name = item.name || dividendInfo?.name || existingStock?.name || symbol;

        const newStockEntry: StockEntry = {
          symbol,
          name,
          shares: finalShares,
          ...(finalCost ? { cost: finalCost } : {}),
          ...(dividendInfo ? { dividendInfo } : {})
        };

        if (user) {
          try {
            const stockRef = doc(db, 'users', user.uid, 'stocks', symbol);
            const payload: any = {
              symbol,
              name,
              shares: finalShares,
              updatedAt: serverTimestamp()
            };
            if (finalCost) payload.cost = finalCost;
            if (dividendInfo) payload.dividendInfo = dividendInfo;

            await setDoc(stockRef, payload, { merge: true });
            successfulItems.push({ symbol, name, entry: newStockEntry });

            const idx = workingStocksList.findIndex(s => normalizeSymbol(s.symbol) === symbol);
            if (idx >= 0) {
              workingStocksList[idx] = newStockEntry;
            } else {
              workingStocksList.push(newStockEntry);
            }
          } catch (itemErr: any) {
            console.error(`Error saving stock ${symbol} to Firestore:`, itemErr);
            failedItems.push({ symbol, error: itemErr?.message || '寫入失敗' });
          }
        } else {
          successfulItems.push({ symbol, name, entry: newStockEntry });
          const idx = workingStocksList.findIndex(s => normalizeSymbol(s.symbol) === symbol);
          if (idx >= 0) {
            workingStocksList[idx] = newStockEntry;
          } else {
            workingStocksList.push(newStockEntry);
          }
        }
      }

      if (failedItems.length > 0) {
        const successSymbols = successfulItems.map(i => i.symbol).join(', ');
        const failureDetails = failedItems.map(f => `- ${f.symbol}: ${f.error}`).join('\n');
        
        let msg = `⚠️ 持股寫入部分失敗：\n\n`;
        if (successfulItems.length > 0) {
          msg += `✅ 成功寫入 ${successfulItems.length} 檔 (${successSymbols})\n`;
        } else {
          msg += `❌ 成功 0 檔\n`;
        }
        msg += `❌ 失敗 ${failedItems.length} 檔：\n${failureDetails}\n\n`;
        msg += `已完整保留所有原有持股資料，未進行刪除。`;

        alert(msg);

        if (successfulItems.length > 0) {
          if (mode === 'replace') {
            const updatedMap = new Map<string, StockEntry>();
            for (const s of currentStocks) {
              updatedMap.set(normalizeSymbol(s.symbol), s);
            }
            for (const item of successfulItems) {
              updatedMap.set(normalizeSymbol(item.symbol), item.entry);
            }
            setStocks(Array.from(updatedMap.values()));
          } else {
            setStocks(workingStocksList);
          }
        }
      } else {
        if (mode === 'replace') {
          const successfulSymbolsSet = new Set(successfulItems.map(i => normalizeSymbol(i.symbol)));
          const oldStocksToDelete = currentStocks.filter(s => !successfulSymbolsSet.has(normalizeSymbol(s.symbol)));

          if (user) {
            for (const oldStock of oldStocksToDelete) {
              const oldSym = normalizeSymbol(oldStock.symbol);
              try {
                await deleteDoc(doc(db, 'users', user.uid, 'stocks', oldSym));
              } catch (delErr) {
                console.warn(`Error deleting old stock ${oldSym} during replace mode:`, delErr);
              }
            }
          }

          const finalReplaceList = successfulItems.map(i => i.entry);
          setStocks(finalReplaceList);
          if (!user) {
            safeStorage.setItem('taiwan_stocks', JSON.stringify(finalReplaceList));
          }
          alert(`🎉 成功取代並更新 ${successfulItems.length} 檔持股！舊持股已清空，股息數據已同步。`);
        } else {
          setStocks(workingStocksList);
          if (!user) {
            safeStorage.setItem('taiwan_stocks', JSON.stringify(workingStocksList));
          }
          alert(`🎉 成功寫入 ${successfulItems.length} 檔持股！股息與市值數據已自動同步。`);
        }
      }
    } catch (err: any) {
      console.error('Error applying screenshot stocks:', err);
      alert(`套用截圖持股時發生錯誤: ${err?.message || err}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveStock = async (symbol: string) => {
    const cleanSym = normalizeSymbol(symbol);
    if (user) {
      const stockRef = doc(db, 'users', user.uid, 'stocks', cleanSym);
      try {
        await deleteDoc(stockRef);
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/stocks/${cleanSym}`);
      }
    }
    setStocks(prev => prev.filter(s => normalizeSymbol(s.symbol) !== cleanSym));
  };

  const handleUpdateShares = async (symbol: string, shares: number) => {
    const cleanSym = normalizeSymbol(symbol);
    const currentStock = stocks.find(s => normalizeSymbol(s.symbol) === cleanSym);
    const updateObj: { shares: number; soldShares?: number } = { shares };
    if (shares === 0 && currentStock && currentStock.shares > 0) {
      if (!currentStock.soldShares) {
        updateObj.soldShares = currentStock.shares;
      }
    }
    setStocks(prev => prev.map(s => normalizeSymbol(s.symbol) === cleanSym ? { ...s, ...updateObj, symbol: cleanSym } : s));
    if (user) {
      const stockRef = doc(db, 'users', user.uid, 'stocks', cleanSym);
      try {
        await setDoc(stockRef, updateObj, { merge: true });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}/stocks/${cleanSym}`);
      }
    }
  };

  // 記錄一筆買進 / 賣出：更新股數與平均成本，並把交易存進該股票的 trades 陣列
  const handleRecordTrade = async (symbol: string, input: { side: TradeSide; shares: number; price: number; tradeDate: string }) => {
    const cleanSym = normalizeSymbol(symbol);
    const currentStock = stocks.find(s => normalizeSymbol(s.symbol) === cleanSym);
    if (!currentStock) throw new Error('找不到這檔股票');
    const now = new Date();
    const { position, trade } = applyTrade(cleanSym, { shares: currentStock.shares, cost: currentStock.cost ?? null }, {
      ...input,
      id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      recordedAt: now.toISOString(),
      recordedDate: format(now, 'yyyy-MM-dd'),
    });
    const trades = [...(currentStock.trades || []), trade];
    const updateObj = { shares: position.shares, cost: position.cost, trades };
    if (user) {
      const stockRef = doc(db, 'users', user.uid, 'stocks', cleanSym);
      await setDoc(stockRef, updateObj, { merge: true });
    }
    setStocks(prev => prev.map(s => normalizeSymbol(s.symbol) === cleanSym ? { ...s, ...updateObj, cost: position.cost ?? undefined, symbol: cleanSym } : s));
  };

  // 復原最後一筆交易（回到交易前的股數與成本）
  const handleUndoLastTrade = async (symbol: string) => {
    const cleanSym = normalizeSymbol(symbol);
    const currentStock = stocks.find(s => normalizeSymbol(s.symbol) === cleanSym);
    const undone = currentStock ? undoLastTrade(currentStock.trades || []) : null;
    if (!undone) return;
    if (!window.confirm('確定要復原最後一筆交易嗎？股數與成本會回到交易前。')) return;
    const updateObj = { shares: undone.position.shares, cost: undone.position.cost, trades: undone.trades };
    if (user) {
      const stockRef = doc(db, 'users', user.uid, 'stocks', cleanSym);
      try {
        await setDoc(stockRef, updateObj, { merge: true });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}/stocks/${cleanSym}`);
        return;
      }
    }
    setStocks(prev => prev.map(s => normalizeSymbol(s.symbol) === cleanSym ? { ...s, ...updateObj, cost: undone.position.cost ?? undefined, symbol: cleanSym } : s));
  };

  const handleUpdateCost = async (symbol: string, cost: number) => {
    const cleanSym = normalizeSymbol(symbol);
    setStocks(prev => prev.map(s => normalizeSymbol(s.symbol) === cleanSym ? { ...s, cost, symbol: cleanSym } : s));
    if (user) {
      const stockRef = doc(db, 'users', user.uid, 'stocks', cleanSym);
      try {
        await setDoc(stockRef, { cost }, { merge: true });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}/stocks/${cleanSym}`);
      }
    }
  };



  const handleUpdateCash = async (newCash: number) => {
    setCash(newCash);
    if (user) {
      const userRef = doc(db, 'users', user.uid);
      try {
        await setDoc(userRef, { cash: newCash }, { merge: true });
      } catch (err) {
        handleFirestoreError(err as any, OperationType.WRITE, `users/${user.uid}/cash`);
      }
    } else {
      safeStorage.setItem('taiwan_cash', newCash.toString());
    }
  };

  const handleRefresh = async (symbol: string, forceApi: boolean = false) => {
    setRefreshingStocks(prev => new Set(prev).add(symbol));
    try {
      let info: DividendInfo | null = null;
      const cacheRef = doc(db, 'market_data', symbol);
      
      // Try to get from global cache first if not forcing API
      if (!forceApi) {
        try {
          const cacheSnap = await getDoc(cacheRef);
          if (cacheSnap.exists()) {
            const cacheData = cacheSnap.data();
            const updatedAt = cacheData.updatedAt?.toDate();
            const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
            
            if (updatedAt && updatedAt > fourHoursAgo) {
              console.log(`Using cached data for ${symbol}`);
              info = cacheData.info as DividendInfo;
            }
          }
        } catch (cacheErr) {
          console.error("Cache read error:", cacheErr);
        }
      } else {
        console.log(`Forcing fresh API fetch for ${symbol}`);
      }

      // If no cache or forcing API, fetch from server
      if (!info) {
        const response = await authenticatedFetch(`/api/dividend/${symbol}`);
        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || '查詢失敗');
        }
        info = await response.json();
        
        if (info) {
          // Update global cache
          try {
            await setDoc(cacheRef, {
              info,
              updatedAt: serverTimestamp()
            });
          } catch (cacheWriteErr) {
            console.error("Cache write error:", cacheWriteErr);
          }
        }
      }

      if (info) {
        if (user) {
          const stockRef = doc(db, 'users', user.uid, 'stocks', symbol);
          const existingStock = stocks.find(s => s.symbol === symbol);
          try {
            // 只更新股息資料，不可寫入 shares：查詢期間使用者可能剛買賣，寫入舊股數會蓋掉交易結果
            await setDoc(stockRef, { 
              symbol: symbol,
              name: info.name || existingStock?.name || symbol,
              ...(existingStock ? {} : { shares: 0 }),
              dividendInfo: info,
              updatedAt: serverTimestamp()
            }, { merge: true });
          } catch (e) {
            handleFirestoreError(e, OperationType.WRITE, `users/${user.uid}/stocks/${symbol}`);
          }
        } else {
          setStocks(prev => prev.map(s => s.symbol === symbol ? { ...s, dividendInfo: info } : s));
        }
      }
    } catch (err: any) {
      console.error(`Error refreshing ${symbol}:`, err);
      const errorMsg = err?.message || String(err);
      
      if (errorMsg.includes('429') || errorMsg.toLowerCase().includes('rate') || errorMsg.toLowerCase().includes('quota')) {
        setError('Google 搜尋額度已達上限（每日 100 次）。目前無法更新此股票，系統已為您保留舊數據。');
      } else {
        setError(`更新資料時發生錯誤: ${errorMsg.length > 30 ? errorMsg.substring(0, 30) + '...' : errorMsg}`);
      }
    } finally {
      setRefreshingStocks(prev => {
        const next = new Set(prev);
        next.delete(symbol);
        return next;
      });
    }
  };

  const handleExportCSV = () => {
    // Export active stocks (持股中)
    const activeStocks = stocks.filter(stock => stock.shares > 0);
    if (activeStocks.length === 0) {
      alert("目前尚無持股中（未清倉）的股票可匯出。");
      return;
    }

    // CSV Header row with BOM to support Microsoft Excel Traditional Chinese encoding properly
    const headers = [
      '股票代號',
      '股票名稱',
      '持有股數',
      '目前現價',
      '目前現值',
      '每股股利',
      '已領股息',
      '未領股息',
      '預計領息總額',
      '預估年收益率 (Yield %)'
    ];

    const rows = activeStocks.map(stock => {
      const symbol = stock.symbol;
      const displaySymbol = /^\d+$/.test(symbol) ? `\t${symbol}` : symbol;
      const name = stock.name;
      const shares = stock.shares;
      const price = stock.dividendInfo?.currentPrice !== undefined ? stock.dividendInfo.currentPrice : '';
      const currentValue = price !== '' ? Math.round(Number(price) * Number(shares)) : 0;
      const yieldPct = stock.dividendInfo?.yield !== undefined ? stock.dividendInfo.yield.toFixed(2) + '%' : '';
      
      let dps = stock.dividendInfo?.amount !== undefined ? stock.dividendInfo.amount : 0;
      let received = 0;
      let pending = 0;
      let total = 0;

      const yearItem = currentYearSummary.byStock.find(s => s.symbol === normalizeSymbol(symbol));
      if (yearItem) {
        received = yearItem.received;
        pending = yearItem.pending;
        total = yearItem.total;
      }

      return [
        displaySymbol,
        name,
        shares,
        price,
        currentValue,
        dps,
        Math.round(received),
        Math.round(pending),
        Math.round(total),
        yieldPct
      ];
    });

    // Generate CSV string with UTF-8 BOM
    const csvContent = "\uFEFF" + [headers.join(','), ...rows.map(e => e.map(val => {
      const strVal = String(val);
      if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
        return `"${strVal.replace(/"/g, '""')}"`;
      }
      return strVal;
    }).join(','))].join('\n');

    // Create Download Link
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `息引力_持股與領息預估_${new Date().getFullYear()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleRefreshAll = async () => {
    if (stocks.length === 0) return;
    setIsLoading(true);
    setError(null);
    try {
      const updatedStocks = [...stocks];
      for (let i = 0; i < updatedStocks.length; i++) {
        const stock = updatedStocks[i];
        try {
          let info: DividendInfo | null = null;
          
          // Refresh All should bypass cache to get the most up-to-date data
          // Add a short delay between requests to avoid hitting rate limits too fast
          if (i > 0) await new Promise(resolve => setTimeout(resolve, 500));
          
          incrementApiUsage();
          const response = await authenticatedFetch(`/api/dividend/${stock.symbol}`);
          if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || '查詢失敗');
          }
          info = await response.json();
          
          if (info) {
            const cacheRef = doc(db, 'market_data', stock.symbol);
            try {
              await setDoc(cacheRef, {
                info,
                updatedAt: serverTimestamp()
              });
            } catch (e) {
              console.warn(`Cache write error for market_data/${stock.symbol}:`, e);
            }
          }

          if (info) {
            if (user) {
              const stockRef = doc(db, 'users', user.uid, 'stocks', stock.symbol);
              try {
                // 只更新股息資料，不可寫入 shares：全部更新要跑好幾十秒，期間買賣的股數會被舊資料蓋掉
                await setDoc(stockRef, { 
                  symbol: stock.symbol,
                  name: stock.name || info.name || stock.symbol,
                  dividendInfo: info,
                  updatedAt: serverTimestamp()
                }, { merge: true });
              } catch (e) {
                handleFirestoreError(e, OperationType.WRITE, `users/${user.uid}/stocks/${stock.symbol}`);
              }
            }
            updatedStocks[i] = { ...stock, dividendInfo: info };
          }
        } catch (err: any) {
          console.error(`Error refreshing ${stock.symbol}:`, err);
          // If we hit a rate limit, stop the whole process and show a clear message
          if (err?.message?.includes('429') || err?.message?.toLowerCase().includes('rate') || err?.message?.toLowerCase().includes('quota')) {
            setError('已達到 API 使用頻率限制 (Google Search 每日額度已滿)。部分股票已從快取更新，其餘請稍候再試。');
            break;
          }
        }
      }
      
      if (!user) {
        setStocks(updatedStocks);
        safeStorage.setItem('taiwan_stocks', JSON.stringify(updatedStocks));
      }
    } catch (err) {
      setError('更新失敗，請稍後再試。');
    } finally {
      setIsLoading(false);
    }
  };


  const calendarEvents = useMemo(() => {
    const events: CalendarEvent[] = [];
    
    stocks.forEach(stock => {
      if (stock.dividendInfo) {
        const historyList = (stock.dividendInfo.history && Array.isArray(stock.dividendInfo.history) && stock.dividendInfo.history.length > 0)
          ? stock.dividendInfo.history
          : (stock.dividendInfo.dividendHistory && Array.isArray(stock.dividendInfo.dividendHistory) && stock.dividendInfo.dividendHistory.length > 0)
            ? stock.dividendInfo.dividendHistory
            : null;

        // If dividend history exists, populate all events from history
        if (historyList && historyList.length > 0) {
          const seenExDates = new Set<string>();
          const seenPayDates = new Set<string>();

          historyList.forEach(div => {
            const exDateStr = div.date; // YYYY-MM-DD
            let payDateStr = div.paymentDate || div.payDate; // YYYY-MM-DD

            // If payment date is empty but ex-dividend date exists, estimate it as ex-dividend date + 1 month
            if (!payDateStr && exDateStr) {
              payDateStr = addOneMonth(exDateStr);
            }

            const exDate = exDateStr ? parseISO(exDateStr) : null;
            const payDate = payDateStr ? parseISO(payDateStr) : null;

            if (exDate && !isNaN(exDate.getTime())) {
              const exKey = `${stock.symbol}-${exDateStr}`;
              if (!seenExDates.has(exKey)) {
                seenExDates.add(exKey);
                events.push({
                  date: exDate,
                  type: 'ex-dividend',
                  stockName: stock.name,
                  symbol: stock.symbol,
                  amount: div.amount || stock.dividendInfo?.amount || 0
                });
              }
            }

            if (payDate && !isNaN(payDate.getTime())) {
              const payKey = `${stock.symbol}-${payDateStr}`;
              if (!seenPayDates.has(payKey)) {
                seenPayDates.add(payKey);
                const effectiveShares = getSharesOnExDate(stock.symbol, exDateStr, stock.shares);
                events.push({
                  date: payDate,
                  type: 'payment',
                  stockName: stock.name,
                  symbol: stock.symbol,
                  amount: estimateNetPayment(div.amount || stock.dividendInfo?.amount || 0, effectiveShares)
                });
              }
            }
          });
        }

        // Always ensure top-level exDividendDate is present
        if (stock.dividendInfo.exDividendDate) {
          const exDate = parseISO(stock.dividendInfo.exDividendDate);
          if (exDate && !isNaN(exDate.getTime())) {
            const alreadyAdded = events.some(e => e.symbol === stock.symbol && e.type === 'ex-dividend' && isSameDay(e.date, exDate));
            if (!alreadyAdded) {
              events.push({
                date: exDate,
                type: 'ex-dividend',
                stockName: stock.name,
                symbol: stock.symbol,
                amount: stock.dividendInfo.amount
              });
            }
          }
        }

        // Always ensure top-level paymentDate is present
        if (stock.dividendInfo.paymentDate) {
          const payDate = parseISO(stock.dividendInfo.paymentDate);
          if (payDate && !isNaN(payDate.getTime())) {
            const alreadyAdded = events.some(e => e.symbol === stock.symbol && e.type === 'payment' && isSameDay(e.date, payDate));
            if (!alreadyAdded) {
              const effectiveShares = getSharesOnExDate(stock.symbol, stock.dividendInfo.exDividendDate || '', stock.shares);
              events.push({
                date: payDate,
                type: 'payment',
                stockName: stock.name,
                symbol: stock.symbol,
                amount: estimateNetPayment(stock.dividendInfo.amount, effectiveShares)
              });
            }
          }
        }
      }
    });
    return events;
  }, [stocks, getSharesOnExDate]);

  // Schedule Today's Notifications (【備註】已由後端 Telegram 推播取代，此為輔助功能)
  useEffect(() => {
    if (!notificationsEnabled || notificationPermission !== 'granted' || stocks.length === 0) return;

    const today = startOfToday();
    const now = new Date();
    const targetHour = 8; // 8:00 AM
    const targetTime = new Date(today);
    targetTime.setHours(targetHour, 0, 0, 0);

    // If it's already past 8 AM today, we don't schedule for today
    if (now > targetTime) return;

    const timeUntilTarget = targetTime.getTime() - now.getTime();

    const timer = setTimeout(() => {
      const todayEvents = calendarEvents.filter(event => isSameDay(event.date, today));
      if (todayEvents.length > 0) {
        todayEvents.forEach(event => {
          const typeStr = event.type === 'ex-dividend' ? '除息日' : '領息日';
          const amountStr = event.type === 'payment' ? `預計領取 $${Math.round(event.amount).toLocaleString()}` : `每股 $${event.amount}`;
          
          try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              new Notification(`今日股息提醒: ${event.stockName}`, {
                body: `今天是 ${event.stockName} 的 ${typeStr}！${amountStr}`,
                icon: '/favicon.svg',
                tag: `${event.symbol}-${event.type}`
              });
            }
          } catch (notifErr) {
            console.warn('[Notification] Mobile notification unsupported or failed:', notifErr);
          }
        });
      }
    }, timeUntilTarget);

    return () => clearTimeout(timer);
  }, [notificationPermission, notificationsEnabled, stocks, calendarEvents]);

  // 今天日期，用來即時判斷已領 / 未領；每分鐘檢查一次，跨日自動更新
  const [todayStr, setTodayStr] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  useEffect(() => {
    const timer = setInterval(() => {
      const now = format(new Date(), 'yyyy-MM-dd');
      setTodayStr(prev => (prev === now ? prev : now));
    }, 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  // 今年（依發放日）的股息彙總，供卡片與 CSV 使用
  const currentYearSummary = useMemo<YearSummary>(() => computeYearDividends({
    stocks,
    snapshots,
    year: Number(todayStr.slice(0, 4)),
    todayStr,
  }), [stocks, snapshots, todayStr]);


  // 歷年股息：只列「開始記錄持股之後」且有股息資料的年份（更早的年份不知道當時持股，算了也不準）
  const yearlyHistoryData = useMemo(() => {
    const currentYear = Number(todayStr.slice(0, 4));
    const firstTrackedYear = snapshots.length > 0 ? Number(snapshots[0].date.slice(0, 4)) : currentYear;
    const years = yearsWithDividends(stocks).filter(yr => yr >= Math.min(firstTrackedYear, currentYear));
    if (!years.includes(currentYear)) years.push(currentYear);
    years.sort((a, b) => a - b);

    return years.map(yr => {
      const summary = computeYearDividends({ stocks, snapshots, year: yr, todayStr });
      const breakdown: Record<string, number> = {};
      summary.byStock.forEach(s => { breakdown[s.symbol] = s.total; });
      return {
        year: yr,
        total: summary.total,
        received: summary.received,
        pending: summary.pending,
        breakdown,
        byStock: summary.byStock,
      };
    }).filter(s => s.total > 0 || s.year === currentYear);
  }, [stocks, snapshots, todayStr]);

  const [componentLimit, setComponentLimit] = useState<number>(10);
  const portfolioData = useMemo(() => {
    let totalValue = 0;
    let totalCost = 0;
    let totalMarketValueOfCostedStocks = 0;
    const allocation: Record<string, number> = {};

    let totalRealizedProfit = 0;
    let totalSoldCost = 0;

    stocks.forEach(stock => {
      const currentPrice = stock.dividendInfo?.currentPrice || 0;
      const shares = stock.shares || 0;
      const marketValue = currentPrice * shares;

      if (shares > 0) {
        totalValue += marketValue;
        allocation[stock.name] = (allocation[stock.name] || 0) + marketValue;

        if (stock.cost && stock.cost > 0) {
          totalCost += stock.cost * shares;
          totalMarketValueOfCostedStocks += marketValue;
        }
      }
      if (stock.trades && stock.trades.length > 0) {
        // 有交易紀錄：已實現損益以每筆賣出為準（部分賣出也算）
        for (const t of stock.trades) {
          if (t.side === 'sell' && t.realizedPnl !== null && t.prevCost !== null) {
            totalRealizedProfit += t.realizedPnl;
            totalSoldCost += t.prevCost * t.shares;
          }
        }
      } else if (shares <= 0) {
        // 舊資料：清倉時手動填的賣出價與股數（沒填股數就不算，避免亂猜）
        const cost = stock.cost || 0;
        const sellPrice = stock.sellPrice || 0;
        const soldShares = stock.soldShares || 0;
        if (cost > 0 && sellPrice > 0 && soldShares > 0) {
          const profit = (sellPrice - cost) * soldShares;
          totalRealizedProfit += profit;
          totalSoldCost += cost * soldShares;
        }
      }
    });

    const totalUnrealizedProfit = totalCost > 0 ? (totalMarketValueOfCostedStocks - totalCost) : 0;
    const totalReturnRate = totalCost > 0 ? (totalUnrealizedProfit / totalCost) * 100 : 0;
    const totalRealizedReturnRate = totalSoldCost > 0 ? (totalRealizedProfit / totalSoldCost) * 100 : 0;

    const rawAllocationData = [...stocks.map(stock => {
      const marketValue = (stock.dividendInfo?.currentPrice || 0) * stock.shares;
      return {
        name: stock.symbol,
        fullName: stock.name,
        value: marketValue,
        percentage: totalValue > 0 ? (marketValue / totalValue) * 100 : 0,
        yield: stock.dividendInfo?.yield || 0
      };
    }).filter(item => item.value > 0)].sort((a, b) => b.value - a.value);

    const topN = rawAllocationData.slice(0, componentLimit);
    const others = rawAllocationData.slice(componentLimit);
    
    const otherValue = others.reduce((sum, item) => sum + item.value, 0);
    const otherPercentage = totalValue > 0 ? (otherValue / totalValue) * 100 : 0;
    
    // Calculate weighted average yield for "Others"
    const otherWeightedYield = otherValue > 0 
      ? others.reduce((sum, item) => sum + (item.yield * item.value), 0) / otherValue 
      : 0;

    const allocationData = others.length > 0
      ? [...topN, { name: '其他', fullName: '其他', value: otherValue, percentage: otherPercentage, yield: otherWeightedYield }]
      : topN;

    // Calculate total weighted average yield
    const totalWeightedYield = totalValue > 0
      ? rawAllocationData.reduce((sum, item) => sum + (item.yield * item.value), 0) / totalValue
      : 0;

    return { totalValue, totalCost, totalUnrealizedProfit, totalReturnRate, allocationData, totalWeightedYield, totalRealizedProfit, totalSoldCost, totalRealizedReturnRate };
  }, [stocks, componentLimit]);

  const handleUpdateTelegramSettings = async (token: string, chatId: string) => {
    setTelegramBotToken(token);
    setTelegramChatId(chatId);
    if (user) {
      const userRef = doc(db, 'users', user.uid);
      try {
        await setDoc(userRef, { 
          telegramBotToken: token,
          telegramChatId: chatId
        }, { merge: true });
      } catch (err) {
        handleFirestoreError(err as any, OperationType.WRITE, `users/${user.uid}/telegram`);
      }
    } else {
      safeStorage.setItem('telegram_bot_token', token);
      safeStorage.setItem('telegram_chat_id', chatId);
    }

    // 動態向 Telegram 註冊此 Webhook，實現雙向即時對話
    if (token) {
      try {
        const response = await authenticatedFetch('/api/telegram/register-webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            botToken: token,
            baseUrl: window.location.origin
          })
        });
        const data = await response.json();
        if (response.ok && data.success) {
          alert(`🎉 設定儲存成功！\n\n${data.description || '機器人已成功啟用雙向智慧對話服務！現在對您的機器人傳送任意訊息，它將為您展示資產及投資建議囉。'}`);
        } else {
          console.warn('Webhook registration failed:', data.error);
          alert('設定儲存成功！不過機器人 Webhook 連線通訊發生些許異常，請檢查 Token 是否填寫無誤。');
        }
      } catch (e) {
        console.error('Failed to register telegram webhook:', e);
        alert('設定已成功儲存！');
      }
    } else {
      alert('🔒 設定已成功儲存！');
    }
  };



  const handleSendTelegramAlert = async () => {
    if (!telegramBotToken || !telegramChatId) {
      alert('請先在設定面板填寫正確的 Bot Token 與 Chat ID！');
      return;
    }

    setIsSendingTelegram(true);
    const totalAssets = portfolioData.totalValue + cash;
    const stockPct = totalAssets > 0 ? ((portfolioData.totalValue / totalAssets) * 100).toFixed(1) : '0';
    const cashPct = totalAssets > 0 ? ((cash / totalAssets) * 100).toFixed(1) : '0';

    // Top Stocks
    const topStocks = [...stocks]
      .filter(s => s.shares > 0)
      .sort((a, b) => {
        const valA = (a.dividendInfo?.currentPrice || 0) * a.shares;
        const valB = (b.dividendInfo?.currentPrice || 0) * b.shares;
        return valB - valA;
      })
      .slice(0, 3);

    const stocksText = topStocks.length > 0 
      ? topStocks.map((s, idx) => {
          const val = (s.dividendInfo?.currentPrice || 0) * s.shares;
          return `${idx + 1}. *${s.name} (${s.symbol})*: $${val.toLocaleString()} 元 (佔證券 ${(val / (portfolioData.totalValue || 1) * 100).toFixed(1)}%)`;
        }).join('\n')
      : '目前無持股部位';

    // Auto balance recommendations
    let recommendation = '';
    if (cash > 1200000) {
      recommendation = `目前您的現金餘額為 $${cash.toLocaleString()} 元，已高於 120 萬防禦性防線（安全水準！）。\n多出的 $${(cash - 1200000).toLocaleString()} 元子彈已整裝待發，可留意季線 MA60 回檔支撐分批加碼，以發揮滾存最高綜效。`;
    } else {
      recommendation = `目前您的現金餘額為 $${cash.toLocaleString()} 元，低於 120 萬防禦性標準配額。\n建議暫緩大筆資金高風險衝刺，優先以「定時定額」或維持防守型存股，等待閒置現金水位回歸安全防禦底線。`;
    }

    const message = `🤖 *【息引力資產動態平衡報告】*\n` +
      `------------------------------------------\n` +
      `📊 *目前總資產水準檢視*\n` +
      `• *總資產價值*：$${totalAssets.toLocaleString()} 元\n` +
      `• *證券總市值*：$${portfolioData.totalValue.toLocaleString()} 元 (${stockPct}%)\n` +
      `• *帳戶閒置現金*：$${cash.toLocaleString()} 元 (${cashPct}%)\n` +
      `• *投資組合加權平均殖利率*：${portfolioData.totalWeightedYield.toFixed(2)}%\n\n` +
      `🏆 *三大核心市值持股部位*\n` +
      `${stocksText}\n\n` +
      `🎯 *下週資產操作配置建議*\n` +
      `${recommendation}\n\n` +
      `👉 _此推播報告由「息引力」資產守護助理動態生成發送。_`;

    try {
      const response = await authenticatedFetch('/api/telegram/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          botToken: telegramBotToken,
          chatId: telegramChatId,
          message: message
        }),
      });

      const data = await response.json();
      if (response.ok && data.success) {
        alert('🎉 Telegram 策略平衡報告發送成功！請查看您的 Telegram。');
      } else {
        alert(`❌ 發送失敗，錯誤說明: ${data.error || '可能是 Bot Token 或 Chat ID 輸入有誤'}`);
      }
    } catch (error: any) {
      console.error(error);
      alert(`❌ 發送失敗: ${error?.message || '請確認與伺服器之網路連線'}`);
    } finally {
      setIsSendingTelegram(false);
    }
  };


  const [apiUsage, setApiUsage] = useState<{ count: number, date: string }>({ count: 0, date: new Date().toDateString() });

  // Load API usage from safeStorage
  useEffect(() => {
    const savedUsage = safeStorage.getItem('api_usage_stats');
    if (savedUsage) {
      try {
        const parsed = JSON.parse(savedUsage);
        if (parsed.date === new Date().toDateString()) {
          setApiUsage(parsed);
        } else {
          const newUsage = { count: 0, date: new Date().toDateString() };
          setApiUsage(newUsage);
          safeStorage.setItem('api_usage_stats', JSON.stringify(newUsage));
        }
      } catch {
        // ignore JSON parse error
      }
    }
  }, []);

  const incrementApiUsage = () => {
    setApiUsage(prev => {
      const next = { ...prev, count: prev.count + 1 };
      safeStorage.setItem('api_usage_stats', JSON.stringify(next));
      return next;
    });
  };
  const [showAddForm, setShowAddForm] = useState(false);
  const [uiTab, setUiTab] = useState<TabKey>('home');
  const [focusSymbol, setFocusSymbol] = useState<string | null>(null);



  // ---------------------------------------------------------------------------
  // 新版畫面（src/ui/）：首頁、持股、股息三個分頁
  // ---------------------------------------------------------------------------
  const upcomingEvents = useMemo(() => listDividendEvents({
    stocks, snapshots, from: todayStr, to: shiftDate(todayStr, 60),
  }), [stocks, snapshots, todayStr]);
  const recentPayments = useMemo(() => listDividendEvents({
    stocks, snapshots, from: shiftDate(todayStr, -30), to: shiftDate(todayStr, -1),
  }).filter(e => e.type === 'payment').reverse(), [stocks, snapshots, todayStr]);

  const holdingItems = useMemo(() => {
    const priceOf = (s: StockEntry) => s.dividendInfo?.currentPrice || (s as any).currentPrice || 0;
    const totalValue = stocks.reduce((a, s) => a + (s.shares > 0 ? priceOf(s) * s.shares : 0), 0);
    const nextBySymbol = new Map<string, DividendEventItem>();
    for (const ev of upcomingEvents) if (!nextBySymbol.has(ev.symbol)) nextBySymbol.set(ev.symbol, ev);
    const items: HoldingItem[] = stocks.map(s => {
      const sym = normalizeSymbol(s.symbol);
      const price = priceOf(s);
      const value = s.shares > 0 ? price * s.shares : 0;
      return {
        stock: { ...s, symbol: sym },
        price,
        value,
        weight: totalValue > 0 ? (value / totalValue) * 100 : 0,
        yieldPct: typeof s.dividendInfo?.yield === 'number' ? s.dividendInfo.yield : null,
        nextEvent: nextBySymbol.get(sym),
        year: currentYearSummary.byStock.find(b => b.symbol === sym),
        updatedLabel: formatUpdatedAt((s as any).priceUpdatedAt || s.dividendInfo?.updatedAt),
      };
    });
    const byValue = (a: HoldingItem, b: HoldingItem) => b.value - a.value || (b.year?.total || 0) - (a.year?.total || 0);
    return {
      totalValue,
      active: items.filter(i => i.stock.shares > 0).sort(byValue),
      cleared: items.filter(i => i.stock.shares <= 0).sort((a, b) => (b.year?.total || 0) - (a.year?.total || 0)),
    };
  }, [stocks, upcomingEvents, currentYearSummary]);

  const dividendYears = useMemo(() => yearlyHistoryData.map(y => y.year), [yearlyHistoryData]);
  const selectedYearSummary = useMemo(() => computeYearDividends({ stocks, snapshots, year: selectedYear, todayStr }),
    [stocks, snapshots, selectedYear, todayStr]);

  const openStock = (symbol: string) => {
    setFocusSymbol(normalizeSymbol(symbol));
    setUiTab('holdings');
  };

  return (
    <>
      <Shell
        tab={uiTab}
        onTab={(t) => { setUiTab(t); setFocusSymbol(null); window.scrollTo({ top: 0 }); }}
        onImport={() => setIsScreenshotModalOpen(true)}
        onAdd={() => setShowAddForm(true)}
        onSettings={() => setShowSettings(true)}
        darkMode={darkMode}
      >
        {error && !showAddForm && (
          <div className="mb-4 rounded-2xl bg-red-50 dark:bg-red-500/10 text-red-600 text-sm font-bold px-4 py-3 flex items-start justify-between gap-2">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 text-red-400">關閉</button>
          </div>
        )}

        {uiTab === 'home' && (
          <HomeView
            summary={currentYearSummary}
            upcoming={upcomingEvents}
            recent={recentPayments}
            todayStr={todayStr}
            onOpenStock={openStock}
            hasStocks={stocks.length > 0}
            onAddStock={() => setShowAddForm(true)}
          />
        )}

        {uiTab === 'holdings' && (
          <HoldingsView
            active={holdingItems.active}
            cleared={holdingItems.cleared}
            totalValue={holdingItems.totalValue}
            totalYearDividend={currentYearSummary.total}
            focusSymbol={focusSymbol}
            onExportCsv={handleExportCSV}
            onUpdateShares={handleUpdateShares}
            onUpdateCost={handleUpdateCost}
            onTrade={(symbol, side) => setTradeModal({ symbol, side })}
            onUndoTrade={handleUndoLastTrade}
            onRefresh={(symbol) => handleRefresh(symbol, true)}
            onDelete={(symbol, name) => setStockToDelete({ symbol, name })}
            refreshing={refreshingStocks}
          />
        )}

        {uiTab === 'dividends' && (
          <DividendsView
            years={dividendYears}
            selectedYear={selectedYear}
            onSelectYear={setSelectedYear}
            summary={selectedYearSummary}
            stocks={stocks}
            snapshots={snapshots}
            todayStr={todayStr}
            onOpenStock={openStock}
          />
        )}
      </Shell>

      <div className={cn(darkMode && 'dark')}>
        <AddStockSheet
          open={showAddForm}
          onClose={() => { setShowAddForm(false); setError(null); }}
          symbol={newSymbol} shares={newShares} cost={newCost}
          onSymbol={setNewSymbol} onShares={setNewShares} onCost={setNewCost}
          onSubmit={handleAddStock}
          onImport={() => { setShowAddForm(false); setIsScreenshotModalOpen(true); }}
          loading={isLoading}
          error={showAddForm ? error : null}
        />
        <SettingsSheet
          open={showSettings}
          onClose={() => setShowSettings(false)}
          user={user}
          darkMode={darkMode}
          onToggleDark={() => setDarkMode(!darkMode)}
          botToken={telegramBotToken}
          chatId={telegramChatId}
          onBotToken={setTelegramBotToken}
          onChatId={setTelegramChatId}
          onSaveTelegram={() => handleUpdateTelegramSettings(telegramBotToken, telegramChatId)}
          onTestTelegram={handleSendTelegramAlert}
          sendingTelegram={isSendingTelegram}
          onRefreshAll={handleRefreshAll}
          refreshingAll={isLoading}
          onLogin={() => { loginWithGoogle(); setShowSettings(false); }}
          onLogout={() => { logout(); setShowSettings(false); }}
        />
        <DeleteStockSheet
          target={stockToDelete}
          onClose={() => setStockToDelete(null)}
          onClear={() => { if (stockToDelete) handleUpdateShares(stockToDelete.symbol, 0); setStockToDelete(null); }}
          onDelete={() => { if (stockToDelete) handleRemoveStock(stockToDelete.symbol); setStockToDelete(null); }}
        />
        {tradeModal && (() => {
          const target = stocks.find(s => normalizeSymbol(s.symbol) === normalizeSymbol(tradeModal.symbol));
          if (!target) return null;
          return (
            <TradeModal
              open
              side={tradeModal.side}
              darkMode={darkMode}
              stock={{
                symbol: normalizeSymbol(target.symbol),
                name: target.name,
                shares: target.shares,
                cost: target.cost ?? null,
                currentPrice: target.dividendInfo?.currentPrice || (target as any).currentPrice,
              }}
              onClose={() => setTradeModal(null)}
              onSubmit={(input) => handleRecordTrade(target.symbol, input)}
            />
          );
        })()}
      </div>

      <AIScreenshotModal
        isOpen={isScreenshotModalOpen}
        onClose={() => setIsScreenshotModalOpen(false)}
        darkMode={darkMode}
        authenticatedFetch={authenticatedFetch}
        onApplyStocks={handleApplyScreenshotStocks}
      />
    </>
  );
}
