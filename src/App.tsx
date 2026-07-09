import * as React from 'react';
import { useState, useEffect, useMemo } from 'react';
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
  MessageSquare
} from 'lucide-react';
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
import type { StockEntry, CalendarEvent, DividendInfo } from './types';
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

export default function App() {
  return <MainApp />;
}

function MainApp() {
  const [stocks, setStocks] = useState<StockEntry[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [newSymbol, setNewSymbol] = useState('');
  const [newShares, setNewShares] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshingStocks, setRefreshingStocks] = useState<Set<string>>(new Set());
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showManualInput, setShowManualInput] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualAmount, setManualAmount] = useState('');
  const [manualExDate, setManualExDate] = useState('');
  const [manualPayDate, setManualPayDate] = useState('');
  const [manualPrice, setManualPrice] = useState('');
  const [expandedEtf, setExpandedEtf] = useState<Set<string>>(new Set());
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => {
    const saved = localStorage.getItem('dividend_notifications_enabled');
    return saved !== 'false'; // Defaults to true
  });
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('dividend_dark_mode');
    return saved === 'true';
  });
  const [isOverviewExpanded, setIsOverviewExpanded] = useState(true);
  const [selectedYear, setSelectedYear] = useState<number>(() => new Date().getFullYear());
  const [hasAutoRefreshed, setHasAutoRefreshed] = useState(false);
  const [cash, setCash] = useState<number>(0);
  const [isEditingCash, setIsEditingCash] = useState(false);
  const [cashInput, setCashInput] = useState('');
  const [telegramBotToken, setTelegramBotToken] = useState(() => {
    return localStorage.getItem('telegram_bot_token') || '8242721109:AAERtesLIWGtwtCKKQRfDUxlEa8yBFt5sPM';
  });
  const [telegramChatId, setTelegramChatId] = useState(() => {
    return localStorage.getItem('telegram_chat_id') || '7654975919';
  });
  const [isSendingTelegram, setIsSendingTelegram] = useState(false);

  // Notification Helpers
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
    localStorage.setItem('dividend_dark_mode', darkMode.toString());
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  // Notifications Enabled State persistence
  useEffect(() => {
    localStorage.setItem('dividend_notifications_enabled', notificationsEnabled.toString());
  }, [notificationsEnabled]);

  // Firestore Sync
  useEffect(() => {
    if (!isAuthReady) return;

    if (user) {
      const stocksRef = collection(db, 'users', user.uid, 'stocks');
      const unsubscribe = onSnapshot(stocksRef, (snapshot) => {
        const firestoreStocks = snapshot.docs.map(doc => doc.data() as StockEntry);
        setStocks(firestoreStocks);
      }, (err) => {
        handleFirestoreError(err, OperationType.LIST, `users/${user.uid}/stocks`);
      });

      return () => unsubscribe();
    } else {
      const saved = localStorage.getItem('taiwan_stocks');
      if (saved) {
        setStocks(JSON.parse(saved));
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
            setTelegramBotToken('8242721109:AAERtesLIWGtwtCKKQRfDUxlEa8yBFt5sPM');
          }
          if (userData.telegramChatId !== undefined && userData.telegramChatId !== '') {
            setTelegramChatId(userData.telegramChatId);
          } else {
            setTelegramChatId('7654975919');
          }
        }
      }, (err) => {
        handleFirestoreError(err, OperationType.GET, `users/${user.uid}`);
      });

      return () => unsubscribe();
    } else {
      const savedCash = localStorage.getItem('taiwan_cash');
      if (savedCash) {
        setCash(Number(savedCash));
      } else {
        setCash(0);
      }
      const savedBotToken = localStorage.getItem('telegram_bot_token');
      const savedChatId = localStorage.getItem('telegram_chat_id');
      setTelegramBotToken(savedBotToken || '8242721109:AAERtesLIWGtwtCKKQRfDUxlEa8yBFt5sPM');
      setTelegramChatId(savedChatId || '7654975919');
    }
  }, [user, isAuthReady]);

  // Synchronize Telegram Chat Data with server JSON Database
  useEffect(() => {
    if (telegramChatId && telegramBotToken) {
      const syncChatData = async () => {
        try {
          await fetch('/api/telegram/save-chat-data', {
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
    }
  }, [telegramChatId, telegramBotToken, cash, stocks, user]);

  // Auto-Register Telegram Webhook in background to ensure it always points to the active dev/prod domain
  useEffect(() => {
    if (telegramBotToken) {
      const registerWebhook = async () => {
        try {
          const response = await fetch('/api/telegram/register-webhook', {
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
    }
  }, [telegramBotToken]);

  // Migration
  useEffect(() => {
    if (user && isAuthReady) {
      const saved = localStorage.getItem('taiwan_stocks');
      if (saved) {
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
          localStorage.removeItem('taiwan_stocks');
        }
      }
    }
  }, [user, isAuthReady, stocks.length]);

  // Local Storage fallback
  useEffect(() => {
    if (!user && isAuthReady) {
      localStorage.setItem('taiwan_stocks', JSON.stringify(stocks));
    }
  }, [stocks, user, isAuthReady]);

  // Auto-heal stale dividend data due to earlier Minguo year bug or older caches
  useEffect(() => {
    if (isAuthReady && stocks.length > 0 && !hasAutoRefreshed && !isLoading) {
      const fixTime = new Date("2026-06-30T07:10:00Z").getTime();
      const needsRefresh = stocks.some(stock => {
        if (!stock.dividendInfo) return true;
        if (stock.dividendInfo.source === '手動輸入') return false;
        if (!stock.dividendInfo.updatedAt) return true;
        return new Date(stock.dividendInfo.updatedAt).getTime() < fixTime;
      });

      if (needsRefresh) {
        setHasAutoRefreshed(true);
        console.log("Stale or buggy dividend format detected. Triggering silent background auto-refresh to heal database...");
        handleRefreshAll();
      }
    }
  }, [stocks, isAuthReady, hasAutoRefreshed, isLoading]);

  const toggleEtfExpansion = (symbol: string) => {
    setExpandedEtf(prev => {
      const next = new Set(prev);
      if (next.has(symbol)) {
        next.delete(symbol);
      } else {
        next.add(symbol);
      }
      return next;
    });
  };

  const handleManualAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSymbol || !manualName || !manualAmount) return;

    setIsLoading(true);
    try {
      const info: DividendInfo = {
        symbol: newSymbol.trim(),
        name: manualName,
        amount: parseFloat(manualAmount),
        exDividendDate: manualExDate || '2024-01-01',
        paymentDate: manualPayDate || '2024-01-01',
        receivedAmountCurrentYear: 0,
        pendingAmountCurrentYear: parseFloat(manualAmount),
        monthlyDistribution: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        currentPrice: parseFloat(manualPrice) || 0,
        yield: manualPrice ? (parseFloat(manualAmount) / parseFloat(manualPrice)) * 100 : 0,
        isEtf: newSymbol.startsWith('00'),
        topComponents: [],
        source: '手動輸入',
        sourceUrl: '',
        updatedAt: new Date().toISOString()
      };

      const stockData: StockEntry = {
        symbol: info.symbol,
        name: info.name,
        shares: newShares || 0,
        dividendInfo: info,
        manualDividendAdjustment: null
      };

      if (user) {
        const stockRef = doc(db, 'users', user.uid, 'stocks', info.symbol);
        await setDoc(stockRef, {
          ...stockData,
          updatedAt: serverTimestamp()
        });
      } else {
        const existingIndex = stocks.findIndex(s => s.symbol === info.symbol);
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
      setShowManualInput(false);
      setManualName('');
      setManualAmount('');
      setManualExDate('');
      setManualPayDate('');
      setManualPrice('');
      setError(null);
      setShowAddForm(false);
    } catch (err) {
      console.error("Manual add error:", err);
      setError("手動新增失敗，請檢查輸入格式。");
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddStock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSymbol) return;

    setIsLoading(true);
    setError(null);
    try {
      let info: DividendInfo | null = null;
      const cacheRef = doc(db, 'market_data', newSymbol);
      
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
        handleFirestoreError(e, OperationType.GET, `market_data/${newSymbol}`);
      }

      if (!info) {
        const response = await fetch(`/api/dividend/${newSymbol}`);
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
            handleFirestoreError(e, OperationType.WRITE, `market_data/${newSymbol}`);
          }
        }
      }

      if (info) {
        const stockData: StockEntry = { 
          symbol: info.symbol, 
          name: info.name, 
          shares: newShares || 0, 
          dividendInfo: info,
          manualDividendAdjustment: null
        };

        if (user) {
          const stockRef = doc(db, 'users', user.uid, 'stocks', info.symbol);
          try {
            await setDoc(stockRef, {
              ...stockData,
              updatedAt: serverTimestamp()
            });
          } catch (e) {
            handleFirestoreError(e, OperationType.WRITE, `users/${user.uid}/stocks/${info.symbol}`);
            throw e; // Re-throw to be caught by the outer catch block
          }
        } else {
          const existingIndex = stocks.findIndex(s => s.symbol === info.symbol);
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

  const handleRemoveStock = async (symbol: string) => {
    if (user) {
      const stockRef = doc(db, 'users', user.uid, 'stocks', symbol);
      try {
        await deleteDoc(stockRef);
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/stocks/${symbol}`);
      }
    } else {
      setStocks(stocks.filter(s => s.symbol !== symbol));
    }
  };

  const handleUpdateShares = async (symbol: string, shares: number) => {
    if (user) {
      const stockRef = doc(db, 'users', user.uid, 'stocks', symbol);
      try {
        await updateDoc(stockRef, { shares });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}/stocks/${symbol}`);
      }
    } else {
      setStocks(stocks.map(s => s.symbol === symbol ? { ...s, shares } : s));
    }
  };

  const handleUpdateManualAdjustment = async (symbol: string, adjustment: number | null) => {
    if (user) {
      const stockRef = doc(db, 'users', user.uid, 'stocks', symbol);
      try {
        await updateDoc(stockRef, { manualDividendAdjustment: adjustment });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}/stocks/${symbol}`);
      }
    } else {
      setStocks(stocks.map(s => s.symbol === symbol ? { ...s, manualDividendAdjustment: adjustment } : s));
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
      localStorage.setItem('taiwan_cash', newCash.toString());
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
        const response = await fetch(`/api/dividend/${symbol}`);
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
          await updateDoc(stockRef, { 
            dividendInfo: info,
            updatedAt: serverTimestamp()
          });
        } else {
          setStocks(stocks.map(s => s.symbol === symbol ? { ...s, dividendInfo: info } : s));
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
      '預估年收益率 (Yield %)',
      '手動調整總額'
    ];

    const rows = stocks.map(stock => {
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
      let manualMark = '';

      if (stock.manualDividendAdjustment !== undefined && stock.manualDividendAdjustment !== null) {
        received = stock.manualDividendAdjustment;
        pending = 0;
        total = stock.manualDividendAdjustment;
        dps = shares > 0 ? Number((stock.manualDividendAdjustment / shares).toFixed(4)) : (stock.dividendInfo?.amount || 0);
        manualMark = String(stock.manualDividendAdjustment);
      } else if (stock.dividendInfo) {
        const info = stock.dividendInfo;
        const rAmount = (info.receivedAmountCurrentYear || (info as any).receivedAmount2026 || 0) * shares;
        const pAmount = (info.pendingAmountCurrentYear || (info as any).pendingAmount2026 || 0) * shares;
        const rAmount_fallback = (info as any).receivedAmount2026 || 0;
        const pAmount_fallback = (info as any).pendingAmount2026 || 0;
        received = rAmount;
        pending = pAmount;
        total = rAmount + pAmount;
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
        yieldPct,
        manualMark
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
          const response = await fetch(`/api/dividend/${stock.symbol}`);
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
              handleFirestoreError(e, OperationType.WRITE, `market_data/${stock.symbol}`);
            }
          }

          if (info) {
            if (user) {
              const stockRef = doc(db, 'users', user.uid, 'stocks', stock.symbol);
              await updateDoc(stockRef, { 
                dividendInfo: info,
                updatedAt: serverTimestamp()
              });
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
        localStorage.setItem('taiwan_stocks', JSON.stringify(updatedStocks));
      }
    } catch (err) {
      setError('更新失敗，請稍後再試。');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefreshStock = async (stock: StockEntry) => {
    setRefreshingStocks(prev => new Set(prev).add(stock.symbol));
    try {
      const response = await fetch(`/api/dividend/${stock.symbol}`);
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || '查詢失敗');
      }
      const info: DividendInfo = await response.json();
      
      if (info) {
        // Update cache
        const cacheRef = doc(db, 'market_data', stock.symbol);
        try {
          await setDoc(cacheRef, {
            info,
            updatedAt: serverTimestamp()
          });
        } catch (e) {
          handleFirestoreError(e, OperationType.WRITE, `market_data/${stock.symbol}`);
        }

        // Update state/firestore
        if (user) {
          const stockRef = doc(db, 'users', user.uid, 'stocks', stock.symbol);
          await updateDoc(stockRef, { 
            dividendInfo: info,
            updatedAt: serverTimestamp()
          });
        } else {
          setStocks(prev => prev.map(s => s.symbol === stock.symbol ? { ...s, dividendInfo: info } : s));
        }
      }
    } catch (err: any) {
      console.error(`Error refreshing ${stock.symbol}:`, err);
      setError(`${stock.symbol} 更新失敗: ${err.message || '未知錯誤'}`);
    } finally {
      setRefreshingStocks(prev => {
        const next = new Set(prev);
        next.delete(stock.symbol);
        return next;
      });
    }
  };

  const calendarEvents = useMemo(() => {
    const events: CalendarEvent[] = [];
    const currentYear = new Date().getFullYear();
    
    stocks.forEach(stock => {
      if (stock.dividendInfo) {
        const exDate = stock.dividendInfo.exDividendDate ? parseISO(stock.dividendInfo.exDividendDate) : null;
        const payDate = stock.dividendInfo.paymentDate ? parseISO(stock.dividendInfo.paymentDate) : null;

        if (exDate && exDate.getFullYear() === currentYear) {
          events.push({
            date: exDate,
            type: 'ex-dividend',
            stockName: stock.name,
            symbol: stock.symbol,
            amount: stock.dividendInfo.amount
          });
        }
        if (payDate && payDate.getFullYear() === currentYear) {
          events.push({
            date: payDate,
            type: 'payment',
            stockName: stock.name,
            symbol: stock.symbol,
            amount: (stock.manualDividendAdjustment !== null && stock.manualDividendAdjustment !== undefined)
              ? stock.manualDividendAdjustment 
              : stock.dividendInfo.amount * stock.shares
          });
        }
      }
    });
    return events;
  }, [stocks]);

  // Schedule Today's Notifications
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
          
          new Notification(`今日股息提醒: ${event.stockName}`, {
            body: `今天是 ${event.stockName} 的 ${typeStr}！${amountStr}`,
            icon: '/favicon.ico',
            tag: `${event.symbol}-${event.type}`
          });
        });
      }
    }, timeUntilTarget);

    return () => clearTimeout(timer);
  }, [notificationPermission, notificationsEnabled, stocks, calendarEvents]);

  const dividendStats = useMemo(() => {
    const today = startOfToday();
    const currentYear = today.getFullYear();
    const todayStr = format(today, 'yyyy-MM-dd');
    
    let received = 0;
    let pending = 0;
    let total = 0;
    const distribution: Record<string, number> = {};
    const monthlyReceivedTotals = Array(12).fill(0);
    const monthlyPendingTotals = Array(12).fill(0);
    const monthlyBreakdown: { symbol: string; amount: number; isPending: boolean }[][] = Array.from({ length: 12 }, () => []);

    stocks.forEach(stock => {
      if (stock.dividendInfo && stock.shares > 0) {
        let stockTotal = 0;
        const info = stock.dividendInfo;
        const symbol = stock.symbol;
        
        // If there's manual adjustment AND it's the current year, override
        if (selectedYear === currentYear && stock.manualDividendAdjustment !== undefined && stock.manualDividendAdjustment !== null) {
          const amount = stock.manualDividendAdjustment;
          total += amount;
          received += amount; 
          stockTotal = amount;
          
          const currentMonthIdx = new Date().getMonth();
          monthlyReceivedTotals[currentMonthIdx] += amount;
          monthlyBreakdown[currentMonthIdx].push({ symbol, amount, isPending: false });
        } else {
          // Check if we have monthly arrays for current year. 
          // If so, ALWAYS use them for currentYear to remain 100% accurate and backward-compatible with saved user portfolios.
          const hasMonthlyDistribution = selectedYear === currentYear && 
            ((info.monthlyDistribution && info.monthlyDistribution.some(v => v > 0)) || 
             (info.pendingMonthlyDistribution && info.pendingMonthlyDistribution.some(v => v > 0)));

          if (hasMonthlyDistribution) {
            let rAmount = 0;
            let pAmount = 0;

            if (info.monthlyDistribution && Array.isArray(info.monthlyDistribution)) {
              info.monthlyDistribution.forEach((monthlyAmount, monthIdx) => {
                if (monthIdx < 12 && monthlyAmount > 0) {
                  const val = monthlyAmount * stock.shares;
                  rAmount += val;
                  monthlyReceivedTotals[monthIdx] += val;
                  monthlyBreakdown[monthIdx].push({ symbol, amount: val, isPending: false });
                }
              });
            }

            if (info.pendingMonthlyDistribution && Array.isArray(info.pendingMonthlyDistribution)) {
              info.pendingMonthlyDistribution.forEach((monthlyAmount, monthIdx) => {
                if (monthIdx < 12 && monthlyAmount > 0) {
                  const val = monthlyAmount * stock.shares;
                  pAmount += val;
                  monthlyPendingTotals[monthIdx] += val;
                  monthlyBreakdown[monthIdx].push({ symbol, amount: val, isPending: true });
                }
              });
            }

            received += rAmount;
            pending += pAmount;
            total += (rAmount + pAmount);
            stockTotal = rAmount + pAmount;
          } else {
            // Use history (or fallback to latest single payment if history is totally empty)
            const hasHistory = info.history && Array.isArray(info.history) && info.history.length > 0;
            const historyItems = hasHistory
              ? info.history!
              : [{
                  date: info.exDividendDate || '',
                  amount: info.amount || 0,
                  paymentDate: info.paymentDate || ''
                }];

            historyItems.forEach(div => {
              if (!div.date) return;
              
              let payDateStr = div.paymentDate || "";
              let pYear = 0;
              let pMonth = 0;
              let formattedPayDateStr = "";
              
              const parts = payDateStr.split('-');
              if (parts.length === 3) {
                pYear = parseInt(parts[0]);
                pMonth = parseInt(parts[1]) - 1;
                formattedPayDateStr = payDateStr;
              } else {
                // Estimate pay date from ex-dividend date (date + 1 month)
                const exParts = div.date.split('-');
                if (exParts.length === 3) {
                  let yearVal = parseInt(exParts[0]);
                  let monthVal = parseInt(exParts[1]); // 1-12
                  monthVal += 1;
                  if (monthVal > 12) {
                    monthVal = 1;
                    yearVal += 1;
                  }
                  pYear = yearVal;
                  pMonth = monthVal - 1;
                  formattedPayDateStr = `${yearVal}-${String(monthVal).padStart(2, '0')}-${exParts[2]}`;
                }
              }
              
              if (pYear === selectedYear && pMonth >= 0 && pMonth < 12) {
                const val = div.amount * stock.shares;
                if (val > 0) {
                  let isPending = false;
                  if (selectedYear < currentYear) {
                    isPending = false;
                  } else if (selectedYear > currentYear) {
                    isPending = true;
                  } else {
                    isPending = formattedPayDateStr > todayStr;
                  }
                  
                  if (isPending) {
                    pending += val;
                    monthlyPendingTotals[pMonth] += val;
                    monthlyBreakdown[pMonth].push({ symbol, amount: val, isPending: true });
                  } else {
                    received += val;
                    monthlyReceivedTotals[pMonth] += val;
                    monthlyBreakdown[pMonth].push({ symbol, amount: val, isPending: false });
                  }
                  total += val;
                  stockTotal += val;
                }
              }
            });
          }
        }

        // Distribution data (using total for the pie chart to show overall contribution)
        if (stockTotal > 0) {
          distribution[stock.name] = (distribution[stock.name] || 0) + stockTotal;
        }
      }
    });

    const distributionData = [...Object.entries(distribution)
      .map(([name, value]) => {
        // Try to find the symbol for this name
        const stock = stocks.find(s => s.name === name);
        return { name: stock ? stock.symbol : name, value };
      })
      .filter(item => item.value > 0)]
      .sort((a, b) => b.value - a.value);

    const monthlyData = monthlyReceivedTotals.map((amount, index) => ({
      month: `${index + 1}月`,
      amount: Math.round(amount),
      pendingAmount: Math.round(monthlyPendingTotals[index]),
      breakdown: monthlyBreakdown[index].sort((a, b) => b.amount - a.amount)
    }));

    return { received, pending, total, distributionData, monthlyData };
  }, [stocks, selectedYear]);

  const [componentLimit, setComponentLimit] = useState<number>(10);
  const portfolioData = useMemo(() => {
    let totalValue = 0;
    const allocation: Record<string, number> = {};

    stocks.forEach(stock => {
      if (stock.dividendInfo && stock.shares > 0) {
        const marketValue = (stock.dividendInfo.currentPrice || 0) * stock.shares;
        totalValue += marketValue;
        
        allocation[stock.name] = (allocation[stock.name] || 0) + marketValue;
      }
    });

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

    return { totalValue, allocationData, totalWeightedYield };
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
      localStorage.setItem('telegram_bot_token', token);
      localStorage.setItem('telegram_chat_id', chatId);
    }

    // 動態向 Telegram 註冊此 Webhook，實現雙向即時對話
    if (token) {
      try {
        const response = await fetch('/api/telegram/register-webhook', {
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
      const response = await fetch('/api/telegram/send', {
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

  const COLORS = ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#fb7185', '#fda4af', '#fecdd3', '#ffe4e6'];

  const [activeTab, setActiveTab] = useState<'calendar' | 'list'>('calendar');
  const [apiUsage, setApiUsage] = useState<{ count: number, date: string }>({ count: 0, date: new Date().toDateString() });

  // Load API usage from localStorage
  useEffect(() => {
    const savedUsage = localStorage.getItem('api_usage_stats');
    if (savedUsage) {
      const parsed = JSON.parse(savedUsage);
      if (parsed.date === new Date().toDateString()) {
        setApiUsage(parsed);
      } else {
        const newUsage = { count: 0, date: new Date().toDateString() };
        setApiUsage(newUsage);
        localStorage.setItem('api_usage_stats', JSON.stringify(newUsage));
      }
    }
  }, []);

  const incrementApiUsage = () => {
    setApiUsage(prev => {
      const next = { ...prev, count: prev.count + 1 };
      localStorage.setItem('api_usage_stats', JSON.stringify(next));
      return next;
    });
  };
  const [showAddForm, setShowAddForm] = useState(false);

  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(monthStart);
    const startDate = startOfWeek(monthStart);
    const endDate = endOfWeek(monthEnd);
    
    const days = [];
    let day = startDate;
    while (day <= endDate) {
      days.push(day);
      day = addDays(day, 1);
    }
    return days;
  }, [currentMonth]);

  const prevMonth = () => setCurrentMonth(subMonths(currentMonth, 1));
  const nextMonth = () => setCurrentMonth(addMonths(currentMonth, 1));

  return (
    <div className={cn(
      "min-h-screen font-sans transition-colors duration-300",
      darkMode ? "bg-slate-950 text-slate-100" : "bg-slate-50 text-slate-900"
    )}>
      <div className="pb-10">
        {/* Header Section */}
        <header className={cn(
          "border-b sticky top-0 z-30 shadow-sm transition-colors duration-300",
          darkMode ? "bg-slate-900 border-slate-800" : "bg-white border-slate-100"
        )}>
          <div className="max-w-4xl mx-auto px-4 py-3">
            <div className="flex justify-between items-center mb-3">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-black tracking-tight text-indigo-500 flex items-center gap-2">
                  <TrendingUp className="w-5 h-5" />
                  息引力
                </h1>
                <select
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(Number(e.target.value))}
                  className={cn(
                    "text-[10px] font-black px-2 py-0.5 rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer shadow-sm select-none",
                    darkMode ? "bg-slate-800 border-slate-700 text-slate-200" : "bg-slate-100 border-slate-200 text-slate-700"
                  )}
                >
                  {[2026, 2027, 2028, 2029, 2030].map(yr => (
                    <option key={yr} value={yr}>{yr} 年度</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2 items-center relative">
                <button 
                  onClick={handleRefreshAll}
                  disabled={isLoading || stocks.length === 0}
                  className={cn(
                    "p-2 rounded-full shadow-sm active:scale-95 transition-all disabled:opacity-50",
                    darkMode ? "bg-slate-800 text-slate-300" : "bg-slate-100 text-slate-600"
                  )}
                  title="重新整理全部"
                >
                  <RefreshCw className={cn("w-5 h-5", isLoading && "animate-spin")} />
                </button>
                
                <div className="relative">
                  <button 
                    onClick={() => {
                      setShowAddForm(!showAddForm);
                      if (showSettings) setShowSettings(false);
                    }}
                    className={cn(
                      "p-2 rounded-full shadow-md active:scale-95 transition-all cursor-pointer",
                      showAddForm 
                        ? "bg-indigo-700 text-white ring-2 ring-indigo-500/50" 
                        : "bg-indigo-600 text-white hover:bg-indigo-700"
                    )}
                    title="新增股票"
                  >
                    <Plus className="w-5 h-5" />
                  </button>

                  <AnimatePresence>
                    {showAddForm && (
                      <>
                        <div 
                          className="fixed inset-0 z-40" 
                          onClick={() => setShowAddForm(false)} 
                        />
                        <motion.div
                          initial={{ opacity: 0, y: 10, scale: 0.95 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 10, scale: 0.95 }}
                          className={cn(
                            "absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl shadow-xl border z-50 p-4",
                            darkMode ? "bg-slate-900 border-slate-800" : "bg-white border-slate-100"
                          )}
                        >
                          <div className="flex justify-between items-center mb-3 pb-2 border-b border-slate-100 dark:border-slate-800">
                            <h3 className={cn("text-xs font-black", darkMode ? "text-slate-200" : "text-slate-800")}>
                              新增股票持股
                            </h3>
                            <button 
                              onClick={() => setShowAddForm(false)}
                              className="text-[10px] font-bold text-slate-400 hover:text-slate-600 cursor-pointer"
                            >
                              關閉
                            </button>
                          </div>

                          <div className="space-y-3">
                            <div className="relative">
                              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                              <input
                                type="text"
                                placeholder="輸入台股代號 (如: 2330)"
                                value={newSymbol}
                                onChange={(e) => setNewSymbol(e.target.value)}
                                className={cn(
                                  "w-full pl-9 pr-4 py-2 border rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/50 transition-all outline-none",
                                  darkMode 
                                    ? "bg-slate-800 text-slate-100 placeholder:text-slate-500 border-slate-700" 
                                    : "bg-slate-50 text-slate-905 placeholder:text-slate-400 border-slate-200"
                                )}
                              />
                            </div>
                            
                            {showManualInput ? (
                              <motion.div 
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="space-y-3 p-3 rounded-xl border border-dashed border-indigo-500/30 bg-indigo-500/5"
                              >
                                <div className="flex justify-between items-center">
                                  <span className="text-[10px] font-bold text-indigo-500 uppercase tracking-wider">手動輸入模式</span>
                                  <button 
                                    onClick={() => setShowManualInput(false)}
                                    className="text-[10px] font-bold text-slate-450 hover:text-slate-700 cursor-pointer"
                                  >
                                    返回自動查詢
                                  </button>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <input
                                    type="text"
                                    placeholder="股票名稱"
                                    value={manualName}
                                    onChange={(e) => setManualName(e.target.value)}
                                    className={cn(
                                      "w-full px-3 py-2 border rounded-xl text-xs font-bold outline-none",
                                      darkMode ? "bg-slate-800 text-slate-100 border-slate-700" : "bg-white text-slate-900 border-slate-200"
                                    )}
                                  />
                                  <input
                                    type="number"
                                    step="0.01"
                                    placeholder="單次配息金額"
                                    value={manualAmount}
                                    onChange={(e) => setManualAmount(e.target.value)}
                                    className={cn(
                                      "w-full px-3 py-2 border rounded-xl text-xs font-bold outline-none",
                                      darkMode ? "bg-slate-800 text-slate-100 border-slate-700" : "bg-white text-slate-900 border-slate-200"
                                    )}
                                  />
                                  <input
                                    type="number"
                                    step="0.1"
                                    placeholder="目前股價 (選填)"
                                    value={manualPrice}
                                    onChange={(e) => setManualPrice(e.target.value)}
                                    className={cn(
                                      "w-full px-3 py-2 border rounded-xl text-xs font-bold outline-none",
                                      darkMode ? "bg-slate-800 text-slate-100 border-slate-700" : "bg-white text-slate-900 border-slate-200"
                                    )}
                                  />
                                  <input
                                    type="number"
                                    step="0.001"
                                    placeholder="持有股數"
                                    value={newShares || ''}
                                    onChange={(e) => setNewShares(e.target.value === '' ? 0 : Number(e.target.value))}
                                    className={cn(
                                      "w-full px-3 py-2 border rounded-xl text-xs font-bold outline-none",
                                      darkMode ? "bg-slate-800 text-slate-100 border-slate-700" : "bg-white text-slate-900 border-slate-200"
                                    )}
                                  />
                                </div>
                                <button
                                  onClick={handleManualAdd}
                                  disabled={isLoading || !newSymbol || !manualName || !manualAmount}
                                  className="w-full py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold shadow-sm cursor-pointer hover:bg-indigo-700 disabled:opacity-50"
                                >
                                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : '手動新增'}
                                </button>
                              </motion.div>
                            ) : (
                              <div className="flex gap-2">
                                <div className="flex-1 relative">
                                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                  <input
                                    type="number"
                                    placeholder="持有股數"
                                    value={newShares || ''}
                                    onFocus={(e) => e.target.select()}
                                    onChange={(e) => setNewShares(e.target.value === '' ? 0 : Number(e.target.value))}
                                    className={cn(
                                      "w-full pl-9 pr-4 py-2 border rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/50 transition-all outline-none",
                                      darkMode 
                                        ? "bg-slate-800 text-slate-100 placeholder:text-slate-500 border-slate-700" 
                                        : "bg-slate-50 text-slate-900 placeholder:text-slate-400 border-slate-200"
                                    )}
                                  />
                                </div>
                                <button
                                  onClick={handleAddStock}
                                  disabled={isLoading || !newSymbol}
                                  className="px-6 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold shadow-sm disabled:opacity-50 active:scale-95 transition-all flex items-center gap-2 cursor-pointer hover:bg-indigo-700"
                                >
                                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : '新增'}
                                </button>
                              </div>
                            )}
                          </div>
                          {error && (
                            <div className="mt-2 space-y-2">
                              <p className="text-[10px] text-red-500 font-bold">{error}</p>
                              {error.includes('上限') && !showManualInput && (
                                <button 
                                  onClick={() => setShowManualInput(true)}
                                  className="text-[10px] font-bold text-indigo-500 underline cursor-pointer"
                                >
                                  點此切換至「手動輸入」模式
                                </button>
                              )}
                            </div>
                          )}
                        </motion.div>
                      </>
                    )}
                  </AnimatePresence>
                </div>
                
                <div className="relative">
                  <button 
                    onClick={() => {
                      setShowSettings(!showSettings);
                      if (showAddForm) setShowAddForm(false);
                    }}
                    className={cn(
                      "p-2 rounded-full shadow-sm active:scale-95 transition-all",
                      darkMode ? "bg-slate-800 text-slate-300" : "bg-slate-100 text-slate-600",
                      showSettings && "ring-2 ring-indigo-500"
                    )}
                  >
                    <Settings className="w-5 h-5" />
                  </button>

                  <AnimatePresence>
                    {showSettings && (
                      <>
                        <div 
                          className="fixed inset-0 z-40" 
                          onClick={() => setShowSettings(false)} 
                        />
                        <motion.div
                          initial={{ opacity: 0, y: 10, scale: 0.95 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 10, scale: 0.95 }}
                          className={cn(
                            "absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl shadow-xl border z-50 overflow-y-auto max-h-[85vh] scrollbar-thin",
                            darkMode ? "bg-slate-900 border-slate-800" : "bg-white border-slate-100"
                          )}
                        >
                          <div className="p-2 space-y-1">
                            {/* User Profile Info */}
                            {user && (
                              <div className="px-3 py-3 mb-1 border-b border-slate-100 dark:border-slate-800">
                                <div className="flex items-center gap-3">
                                  {user.photoURL ? (
                                    <img src={user.photoURL} alt="" className="w-8 h-8 rounded-full" referrerPolicy="no-referrer" />
                                  ) : (
                                    <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center">
                                      <UserIcon className="w-4 h-4 text-indigo-500" />
                                    </div>
                                  )}
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-black truncate">{user.displayName || '使用者'}</p>
                                    <p className="text-[10px] text-slate-500 truncate">{user.email}</p>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* Dark Mode Toggle */}
                            <button
                              onClick={() => setDarkMode(!darkMode)}
                              className={cn(
                                "w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-bold transition-colors select-none cursor-pointer",
                                darkMode ? "hover:bg-slate-800 text-slate-300" : "hover:bg-slate-50 text-slate-600"
                              )}
                            >
                              <div className="flex items-center gap-2">
                                {darkMode ? <Sun className="w-4 h-4 text-yellow-400" /> : <Moon className="w-4 h-4 text-indigo-500" />}
                                <span>{darkMode ? '亮色模式' : '深色模式'}</span>
                              </div>
                              <div className={cn(
                                "w-8 h-4 rounded-full relative transition-colors",
                                darkMode ? "bg-indigo-600" : "bg-slate-300"
                              )}>
                                <div className={cn(
                                  "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all",
                                  darkMode ? "right-0.5" : "left-0.5"
                                )} />
                              </div>
                            </button>

                            {/* Notification Toggle */}
                            <button
                              onClick={async () => {
                                if (!notificationsEnabled) {
                                  await requestNotificationPermission();
                                  setNotificationsEnabled(true);
                                } else {
                                  setNotificationsEnabled(false);
                                }
                              }}
                              className={cn(
                                "w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer select-none",
                                darkMode ? "hover:bg-slate-800 text-slate-300" : "hover:bg-slate-50 text-slate-600"
                              )}
                            >
                              <div className="flex items-center gap-2">
                                <BellRing className={cn("w-4 h-4", notificationsEnabled ? "text-emerald-500 animate-pulse" : "text-slate-400")} />
                                <span>除息領息通知</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                {notificationsEnabled && (
                                  <span 
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      testNotification();
                                    }}
                                    className="text-[10px] text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 font-bold underline px-1.5 cursor-pointer hover:opacity-80"
                                  >
                                    測試
                                  </span>
                                )}
                                <div className={cn(
                                  "w-8 h-4 rounded-full relative transition-colors",
                                  notificationsEnabled ? "bg-indigo-600" : "bg-slate-300"
                                )}>
                                  <div className={cn(
                                    "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all",
                                    notificationsEnabled ? "right-0.5" : "left-0.5"
                                  )} />
                                </div>
                              </div>
                            </button>

                            {/* Telegram Integration Settings */}
                            <div className={cn(
                              "px-3 py-2.5 border-t border-slate-100 dark:border-slate-800 mt-1",
                              darkMode ? "text-slate-300" : "text-slate-600"
                            )}>
                              <div className="flex items-center justify-between mb-1.5">
                                <div className="flex items-center gap-1.5">
                                  <MessageSquare className="w-4 h-4 text-sky-500" />
                                  <p className="text-[10px] font-black uppercase tracking-wider opacity-60">Telegram 推播設定</p>
                                </div>
                                <a 
                                  href="https://t.me/BotFather" 
                                  target="_blank" 
                                  rel="noreferrer" 
                                  className="text-[9px] text-sky-500 hover:underline font-bold"
                                >
                                  申請機器人 ↗
                                </a>
                              </div>
                              <div className="flex flex-col gap-2">
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="flex flex-col gap-0.5">
                                    <span className="text-[9px] font-bold opacity-60">Bot Token</span>
                                    <input
                                      type="password"
                                      value={telegramBotToken}
                                      onChange={(e) => setTelegramBotToken(e.target.value)}
                                      placeholder="Bot Token"
                                      className={cn(
                                        "w-full text-[10px] font-medium rounded-lg px-2 py-1 border focus:outline-none focus:ring-1 focus:ring-sky-500",
                                        darkMode ? "bg-slate-800 border-slate-700 text-slate-100" : "bg-white border-slate-200 text-slate-800"
                                      )}
                                    />
                                  </div>
                                  <div className="flex flex-col gap-0.5">
                                    <span className="text-[9px] font-bold opacity-60">Chat ID</span>
                                    <input
                                      type="text"
                                      value={telegramChatId}
                                      onChange={(e) => setTelegramChatId(e.target.value)}
                                      placeholder="Chat ID"
                                      className={cn(
                                        "w-full text-[10px] font-medium rounded-lg px-2 py-1 border focus:outline-none focus:ring-1 focus:ring-sky-500",
                                        darkMode ? "bg-slate-800 border-slate-700 text-slate-100" : "bg-white border-slate-200 text-slate-800"
                                      )}
                                    />
                                  </div>
                                </div>
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => handleUpdateTelegramSettings(telegramBotToken, telegramChatId)}
                                    className={cn(
                                      "flex-1 text-[10px] font-black uppercase tracking-wider py-1 rounded-lg border shadow-sm transition-all active:scale-95 text-center cursor-pointer",
                                      darkMode 
                                        ? "bg-slate-700 hover:bg-slate-600 text-slate-200 border-slate-600" 
                                        : "bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200"
                                    )}
                                  >
                                    儲存設定
                                  </button>
                                  <button
                                    onClick={handleSendTelegramAlert}
                                    disabled={isSendingTelegram}
                                    className="flex-1 flex items-center justify-center gap-1 text-[10px] font-black uppercase tracking-wider py-1 rounded-lg bg-sky-500 text-white hover:bg-sky-600 transition-colors shadow-sm active:scale-95 disabled:opacity-50 cursor-pointer"
                                  >
                                    {isSendingTelegram ? (
                                      <>
                                        <Loader2 className="w-3 animate-spin" />
                                        <span>發送中...</span>
                                      </>
                                    ) : (
                                      <>
                                        <Send className="w-3 h-3" />
                                        <span>測試發送</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                              </div>
                            </div>

                            {/* Auth Actions */}
                            {isAuthReady && (
                              user ? (
                                <button
                                  onClick={() => {
                                    logout();
                                    setShowSettings(false);
                                  }}
                                  className={cn(
                                    "w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-red-500 transition-colors",
                                    darkMode ? "hover:bg-red-950/30" : "hover:bg-red-50"
                                  )}
                                >
                                  <LogOut className="w-4 h-4" />
                                  <span>登出帳號</span>
                                </button>
                              ) : (
                                <button
                                  onClick={() => {
                                    loginWithGoogle();
                                    setShowSettings(false);
                                  }}
                                  className={cn(
                                    "w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-indigo-500 transition-colors",
                                    darkMode ? "hover:bg-indigo-950/30" : "hover:bg-indigo-50"
                                  )}
                                >
                                  <LogIn className="w-4 h-4" />
                                  <span>Google 登入同步</span>
                                </button>
                              )
                            )}
                          </div>
                        </motion.div>
                      </>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
            
            <div className="grid grid-cols-3 gap-2">
              <div className={cn(
                "p-2 rounded-xl border flex flex-col items-center text-center transition-colors",
                darkMode ? "bg-slate-800 border-slate-700" : "bg-slate-50 border-slate-100"
              )}>
                <p className={cn(
                  "text-[9px] font-bold uppercase tracking-wider",
                  darkMode ? "text-slate-500" : "text-slate-400"
                )}>{selectedYear} 年度總額</p>
                <p className={cn(
                  "text-sm font-black",
                  darkMode ? "text-slate-100" : "text-slate-900"
                )}>${dividendStats.total.toLocaleString()}</p>
              </div>

              <div className={cn(
                "p-2 rounded-xl border flex flex-col items-center text-center transition-colors",
                darkMode ? "bg-emerald-950/30 border-emerald-900/50" : "bg-emerald-50/50 border-emerald-100"
              )}>
                <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-wider">
                  {selectedYear === new Date().getFullYear() ? "今年已領" : `${selectedYear} 已領`}
                </p>
                <p className="text-sm font-black text-emerald-500">${dividendStats.received.toLocaleString()}</p>
              </div>

              <div className={cn(
                "p-2 rounded-xl border flex flex-col items-center text-center transition-colors",
                darkMode ? "bg-orange-950/30 border-orange-900/50" : "bg-orange-50/50 border-orange-100"
              )}>
                <p className="text-[9px] font-bold text-orange-500 uppercase tracking-wider">
                  {selectedYear === new Date().getFullYear() ? "今年未領" : `${selectedYear} 待領`}
                </p>
                <p className="text-sm font-black text-orange-500">${dividendStats.pending.toLocaleString()}</p>
              </div>
            </div>
          </div>
        </header>

      <main className="max-w-4xl mx-auto px-4 py-4 space-y-4">
        {/* Dividend Distribution Dashboard - Now Full Width */}
        <div className={cn(
          "p-4 rounded-2xl shadow-sm border transition-colors flex flex-col",
          darkMode ? "bg-slate-800 border-slate-700" : "bg-white border-slate-100"
        )}>
          <button 
            onClick={() => setIsOverviewExpanded(!isOverviewExpanded)}
            className="flex justify-between items-center mb-2 shrink-0 group"
          >
            <div className="flex flex-col text-left">
              <h2 className={cn("text-sm font-black", darkMode ? "text-slate-100" : "text-slate-900")}>{selectedYear} 股息概況</h2>
              <p className="text-[10px] text-slate-500 font-bold">點擊{isOverviewExpanded ? '收合' : '展開'}詳細分析</p>
            </div>
            <div className={cn(
              "p-1.5 rounded-lg transition-colors",
              darkMode ? "bg-slate-700 text-slate-300 group-hover:bg-slate-600" : "bg-slate-100 text-slate-500 group-hover:bg-slate-200"
            )}>
              {isOverviewExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </button>
          
          <AnimatePresence>
            {isOverviewExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="flex flex-col md:flex-row gap-4 items-center pt-2">
                  {/* Pie Chart with Top 1 Focus */}
                  <div className="h-64 flex flex-col w-full md:w-1/2 relative">
              <ResponsiveContainer width="100%" height="100%">
                <RechartsPieChart margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                  <Pie
                    data={dividendStats.distributionData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius="60%"
                    outerRadius="80%"
                    paddingAngle={2}
                    label={false}
                  >
                    {dividendStats.distributionData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" className={cn("text-[10px] font-bold", darkMode ? "fill-slate-400" : "fill-slate-600")}>
                    <tspan x="50%" dy="-0.5em">預計總額</tspan>
                    <tspan x="50%" dy="1.2em" className={cn("text-[14px] font-black", darkMode ? "fill-slate-100" : "fill-slate-900")}>
                      ${dividendStats.total.toLocaleString()}
                    </tspan>
                  </text>
                  <RechartsTooltip 
                    formatter={(value: number, name: string) => [`$${value.toLocaleString()}`, name]}
                    contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)', fontSize: '10px' }}
                  />
                </RechartsPieChart>
              </ResponsiveContainer>
            </div>
            
            {/* Legend as List View - Moved to the right */}
            <div className="w-full md:w-1/2 space-y-1.5 overflow-y-auto max-h-[160px] pr-2 custom-scrollbar">
              {dividendStats.distributionData.map((entry, index) => (
                <div key={entry.name} className="flex items-center justify-between text-[10px] py-0.5 border-b border-slate-100 dark:border-slate-800/50 last:border-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                    <span className={cn("font-bold truncate", darkMode ? "text-slate-300" : "text-slate-700")}>{entry.name}</span>
                  </div>
                  <span className={cn("font-mono font-bold shrink-0 ml-2", darkMode ? "text-slate-100" : "text-slate-900")}>${entry.value.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>

            {/* Monthly Bar Chart */}
            <div className={cn("pt-6 flex flex-col h-64 w-full border-t mt-4", darkMode ? "border-slate-700" : "border-slate-100")}>
              <h3 className={cn("text-[9px] sm:text-[10px] font-bold mb-1 uppercase tracking-wider shrink-0", darkMode ? "text-slate-500" : "text-slate-400")}>每月股息</h3>
              <div className="flex-1 min-h-0 relative">
                {dividendStats.monthlyData.some(d => d.amount > 0 || d.pendingAmount > 0) ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dividendStats.monthlyData} margin={{ top: 15, right: 10, left: -10, bottom: 0 }}>
                      <XAxis 
                        dataKey="month" 
                        axisLine={false} 
                        tickLine={false} 
                        interval={0}
                        tick={(props) => {
                          const { x, y, payload } = props;
                          const monthNum = parseInt(payload.value);
                          const isCurrentMonth = monthNum === (new Date().getMonth() + 1);
                          return (
                            <text 
                              x={x} 
                              y={y} 
                              dy={10} 
                              textAnchor="middle" 
                              fontSize={9} 
                              fontWeight={isCurrentMonth ? 900 : 700} 
                              fill={isCurrentMonth ? "#10b981" : (darkMode ? "#94a3b8" : "#64748b")}
                            >
                              {payload.value}
                            </text>
                          );
                        }}
                      />
                      <YAxis 
                        hide={false} 
                        tick={{ fontSize: 8, fill: darkMode ? '#94a3b8' : '#64748b' }}
                        axisLine={false}
                        tickLine={false}
                        width={30}
                        tickFormatter={(value) => value >= 1000 ? `${(value/1000).toFixed(0)}k` : value}
                      />
                      <RechartsTooltip 
                        cursor={{ fill: darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.02)' }}
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            const data = payload[0].payload;
                            return (
                              <div className={cn(
                                "px-3 py-2 rounded-xl shadow-xl border text-[10px] font-bold z-50",
                                darkMode ? "bg-slate-900 border-slate-800 text-slate-200" : "bg-white border-slate-100 text-slate-700"
                              )}>
                                <p className="mb-2 opacity-100 border-b pb-1 border-slate-100 dark:border-slate-800 flex justify-between">
                                  <span>{data.month} 股息明細</span>
                                  <span className="opacity-50 font-normal">總計: ${(data.amount + data.pendingAmount).toLocaleString()}</span>
                                </p>
                                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                                  {data.breakdown && data.breakdown.map((item: any, idx: number) => (
                                    <div key={idx} className="flex justify-between items-center gap-4">
                                      <div className="flex items-center gap-1.5">
                                        <div className={cn(
                                          "w-1 h-1 rounded-full",
                                          item.isPending ? "bg-amber-500" : "bg-emerald-500"
                                        )} />
                                        <span className="opacity-70">{item.symbol}</span>
                                      </div>
                                      <span className={cn(
                                        "font-mono",
                                        item.isPending ? "text-amber-500" : "text-emerald-500"
                                      )}>+${Math.round(item.amount).toLocaleString()}</span>
                                    </div>
                                  ))}
                                  {(!data.breakdown || data.breakdown.length === 0) && (
                                    <p className="text-slate-500 py-1 font-normal italic">此月份無資料</p>
                                  )}
                                </div>
                              </div>
                            );
                          }
                          return null;
                        }}
                      />
                      <Bar dataKey="amount" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]}>
                        <LabelList 
                          dataKey="amount" 
                          position="top" 
                          formatter={(v: number) => v > 0 ? `${v >= 1000 ? (v/1000).toFixed(0) + 'k' : v}` : ''} 
                          style={{ fontSize: 7, fontWeight: 800, fill: darkMode ? '#10b981' : '#059669' }} 
                        />
                      </Bar>
                      <Bar dataKey="pendingAmount" stackId="a" fill="#f59e0b" radius={[2, 2, 0, 0]}>
                        <LabelList 
                          dataKey="pendingAmount" 
                          position="top" 
                          formatter={(v: number) => v > 0 ? `${v >= 1000 ? (v/1000).toFixed(0) + 'k' : v}` : ''} 
                          style={{ fontSize: 7, fontWeight: 800, fill: darkMode ? '#f59e0b' : '#d97706' }} 
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-slate-400">
                    <TrendingUp className="w-8 h-8 mb-2 opacity-20" />
                    <p className="text-[10px] opacity-50">尚無今年股息分佈資料</p>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
          


        {/* Tabs - Compact */}
        <div className={cn(
          "flex p-1 rounded-xl transition-colors",
          darkMode ? "bg-slate-900/50" : "bg-slate-200/50"
        )}>
          <button
            onClick={() => setActiveTab('calendar')}
            className={cn(
              "flex-1 py-2 text-xs font-bold rounded-lg transition-all",
              activeTab === 'calendar' 
                ? (darkMode ? "bg-slate-800 text-indigo-400 shadow-sm" : "bg-white text-indigo-600 shadow-sm")
                : (darkMode ? "text-slate-500" : "text-slate-500")
            )}
          >
            股息行事曆
          </button>
          <button
            onClick={() => setActiveTab('list')}
            className={cn(
              "flex-1 py-2 text-xs font-bold rounded-lg transition-all",
              activeTab === 'list' 
                ? (darkMode ? "bg-slate-800 text-indigo-400 shadow-sm" : "bg-white text-indigo-600 shadow-sm")
                : (darkMode ? "text-slate-500" : "text-slate-500")
            )}
          >
            我的清單 ({stocks.length})
          </button>
        </div>

        {/* Content Area */}
        <div className="min-h-[400px]">
          {activeTab === 'calendar' ? (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-4"
            >
              {/* Calendar - More Compact */}
              <div className={cn(
                "p-3 rounded-2xl shadow-sm border transition-colors",
                darkMode ? "bg-slate-900 border-slate-800" : "bg-white border-slate-100"
              )}>
                <div className="flex justify-between items-center mb-3 px-1">
                  <h2 className={cn(
                    "text-sm font-black",
                    darkMode ? "text-slate-100" : "text-slate-800"
                  )}>
                    {format(currentMonth, 'yyyy年 MMMM', { locale: zhTW })}
                  </h2>
                  <div className="flex gap-1">
                    <button onClick={prevMonth} className={cn(
                      "p-1.5 rounded-lg transition-colors",
                      darkMode ? "hover:bg-slate-800" : "hover:bg-slate-50"
                    )}>
                      <ChevronLeft className={cn("w-4 h-4", darkMode ? "text-slate-400" : "text-slate-600")} />
                    </button>
                    <button onClick={nextMonth} className={cn(
                      "p-1.5 rounded-lg transition-colors",
                      darkMode ? "hover:bg-slate-800" : "hover:bg-slate-50"
                    )}>
                      <ChevronRight className={cn("w-4 h-4", darkMode ? "text-slate-400" : "text-slate-600")} />
                    </button>
                  </div>
                </div>
                
                <div className="grid grid-cols-7 gap-1">
                  {['日', '一', '二', '三', '四', '五', '六'].map(day => (
                    <div key={day} className="text-center text-[10px] font-bold text-slate-400 py-1">
                      {day}
                    </div>
                  ))}
                  {calendarDays.map((day, idx) => {
                    const dayEvents = calendarEvents.filter(e => isSameDay(e.date, day));
                    const isTodayDate = isToday(day);
                    const isCurrentMonth = isSameMonth(day, currentMonth);
                    
                    return (
                      <div 
                        key={idx} 
                        className={cn(
                          "min-h-[50px] p-1 rounded-lg border transition-colors",
                          isCurrentMonth 
                            ? (darkMode ? "bg-slate-900 border-slate-800" : "bg-white border-slate-50")
                            : (darkMode ? "bg-slate-950/30 border-transparent opacity-20" : "bg-slate-50/30 border-transparent opacity-30")
                        )}
                      >
                        <div className="flex justify-between items-start">
                          <span className={cn(
                            "text-[10px] font-bold",
                            isTodayDate 
                              ? "bg-indigo-600 text-white w-4 h-4 flex items-center justify-center rounded-full" 
                              : (darkMode ? "text-slate-500" : "text-slate-500")
                          )}>
                            {format(day, 'd')}
                          </span>
                        </div>
                        <div className="mt-1 space-y-0.5">
                          {dayEvents.map((event, eIdx) => (
                            <div 
                              key={eIdx}
                              className={cn(
                                "text-[8px] px-1 py-0.5 rounded-sm truncate font-bold border-l-2",
                                event.type === 'ex-dividend' 
                                  ? (darkMode ? "bg-orange-950/40 text-orange-400 border-orange-500" : "bg-orange-100 text-orange-700 border-orange-500")
                                  : (darkMode ? "bg-emerald-950/40 text-emerald-400 border-emerald-500" : "bg-emerald-100 text-emerald-700 border-emerald-500")
                              )}
                            >
                              {event.type === 'ex-dividend' ? '除' : '領'}{event.stockName}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Event List - Compact */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">本月行程</h3>
                {[...calendarEvents]
                  .filter(e => isSameMonth(e.date, currentMonth))
                  .sort((a, b) => a.date.getTime() - b.date.getTime())
                  .map((event, idx) => (
                    <div key={idx} className={cn(
                      "p-3 rounded-xl shadow-sm border flex items-center gap-3 transition-colors",
                      darkMode ? "bg-slate-900 border-slate-800" : "bg-white border-slate-100"
                    )}>
                      <div className={cn(
                        "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                        event.type === 'ex-dividend' 
                          ? (darkMode ? "bg-orange-950/40" : "bg-orange-50")
                          : (darkMode ? "bg-emerald-950/40" : "bg-emerald-50")
                      )}>
                        {event.type === 'ex-dividend' ? <CalendarIcon className="w-4 h-4 text-orange-500" /> : <DollarSign className="w-4 h-4 text-emerald-500" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start">
                          <p className={cn(
                            "text-xs font-black truncate",
                            darkMode ? "text-slate-100" : "text-slate-800"
                          )}>{event.stockName} ({event.symbol})</p>
                          <p className="text-[10px] font-bold text-slate-400">{format(event.date, 'MM/dd')}</p>
                        </div>
                        <p className="text-[10px] text-slate-500 font-medium">
                          {event.type === 'ex-dividend' ? `除息 $${event.amount}` : `發放 $${event.amount.toLocaleString()}`}
                        </p>
                      </div>
                    </div>
                  ))}
              </div>
            </motion.div>
          ) : (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-3"
            >
              <div className="grid grid-cols-1 gap-3">
                {stocks.length === 0 ? (
                  <div className={cn(
                    "text-center py-12 rounded-2xl border border-dashed transition-colors",
                    darkMode ? "bg-slate-900 border-slate-800" : "bg-white border-slate-200"
                  )}>
                    <div className={cn(
                      "w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3",
                      darkMode ? "bg-slate-800" : "bg-slate-50"
                    )}>
                      <Search className="w-6 h-6 text-slate-300" />
                    </div>
                    <p className="text-sm text-slate-400 font-medium">尚未加入任何股票</p>
                  </div>
                ) : (
                  stocks.map((stock) => (
                  <motion.div 
                    key={stock.symbol}
                    layout
                    className={cn(
                      "p-3 rounded-2xl shadow-sm border group relative transition-colors",
                      darkMode ? "bg-slate-900 border-slate-800" : "bg-white border-slate-100"
                    )}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <h3 className={cn(
                          "text-sm font-black leading-tight flex items-center flex-wrap gap-1.5",
                          darkMode ? "text-slate-100" : "text-slate-800"
                        )}>
                          <span className="truncate">{stock.name}</span>
                          {stock.dividendInfo?.isEtf && (
                            <span className="px-1.5 py-0.5 rounded-md bg-indigo-500/10 text-indigo-500 text-[8px] font-black uppercase shrink-0">ETF</span>
                          )}
                        </h3>
                        <div className="flex items-center gap-2">
                          <p className="text-[10px] font-bold text-slate-400">{stock.symbol}</p>
                          {stock.dividendInfo?.currentPrice && (
                            <p className="text-[10px] font-black text-indigo-500">
                              現價: ${stock.dividendInfo.currentPrice.toLocaleString()}
                            </p>
                          )}
                          {stock.dividendInfo?.updatedAt && (
                            <div className="text-[8px] text-slate-500 font-medium flex items-center gap-1 flex-wrap">
                              <span>更新於: {new Date(stock.dividendInfo.updatedAt).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                              {stock.dividendInfo.source && (
                                <span>
                                  (來源: {stock.dividendInfo.sourceUrl ? (
                                    <a href={stock.dividendInfo.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-500 underline">
                                      {stock.dividendInfo.source}
                                    </a>
                                  ) : stock.dividendInfo.source})
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-1 items-center shrink-0">
                        {stock.dividendInfo?.isEtf && (
                          <button 
                            onClick={() => toggleEtfExpansion(stock.symbol)}
                            className={cn(
                              "flex items-center gap-1 px-2 py-1 rounded-lg transition-all active:scale-95 whitespace-nowrap",
                              expandedEtf.has(stock.symbol) 
                                ? "bg-indigo-500 text-white shadow-sm" 
                                : darkMode 
                                  ? "bg-slate-800 text-indigo-400 hover:bg-slate-700" 
                                  : "bg-indigo-50 text-indigo-600 hover:bg-indigo-100"
                            )}
                          >
                            <PieChart className="w-3.5 h-3.5 shrink-0" />
                            <span className="text-[10px] font-black">成分股</span>
                            {expandedEtf.has(stock.symbol) ? <ChevronUp className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />}
                          </button>
                        )}
                        <button
                          onClick={() => handleRefreshStock(stock)}
                          disabled={refreshingStocks.has(stock.symbol)}
                          className={cn(
                            "p-1.5 rounded-lg transition-colors",
                            darkMode ? "hover:bg-slate-800 text-slate-500" : "hover:bg-slate-100 text-slate-400"
                          )}
                          title="重新整理此股票"
                        >
                          <RefreshCw className={cn("w-3.5 h-3.5", refreshingStocks.has(stock.symbol) && "animate-spin")} />
                        </button>
                        <button 
                          onClick={() => handleRemoveStock(stock.symbol)}
                          className={cn(
                            "p-1.5 rounded-lg transition-colors",
                            darkMode ? "text-slate-400 hover:bg-red-900/30 hover:text-red-400" : "text-slate-400 hover:bg-red-50 hover:text-red-500"
                          )}
                          title="刪除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {stock.dividendInfo ? (
                      <div className="mt-3 space-y-2">
                        {/* Year Badge if not current year */}
                        {(() => {
                          const currentYear = new Date().getFullYear();
                          const exYear = stock.dividendInfo.exDividendDate ? new Date(stock.dividendInfo.exDividendDate).getFullYear() : null;
                          const payYear = stock.dividendInfo.paymentDate ? new Date(stock.dividendInfo.paymentDate).getFullYear() : null;
                          const dataYear = exYear || payYear;
                          
                          if (dataYear && dataYear < currentYear) {
                            return (
                              <div className={cn(
                                "px-2 py-1 rounded-lg text-[9px] font-bold flex items-center gap-1.5 mb-2",
                                darkMode ? "bg-amber-500/10 text-amber-500" : "bg-amber-50 text-amber-600"
                              )}>
                                <AlertCircle className="w-3 h-3" />
                                <span>顯示為 {dataYear} 年資訊 ({new Date().getFullYear()} 尚未公佈)</span>
                              </div>
                            );
                          }
                          return null;
                        })()}

                        {/* ETF Components Dropdown */}
                        <AnimatePresence>
                          {expandedEtf.has(stock.symbol) && stock.dividendInfo?.isEtf && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              className="overflow-hidden"
                            >
                              <div className={cn(
                                "p-2 rounded-xl mb-2 space-y-1.5",
                                darkMode ? "bg-slate-800/50" : "bg-slate-50/50"
                              )}>
                                <div className="flex justify-between items-center px-1 mb-1">
                                  <p className="text-[8px] font-black text-indigo-500 uppercase tracking-wider">前十大成分股</p>
                                </div>
                                {stock.dividendInfo.topComponents && stock.dividendInfo.topComponents.length > 0 ? (
                                  stock.dividendInfo.topComponents.map((comp, idx) => (
                                    <div key={idx} className="flex justify-between items-center px-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-[9px] font-bold text-slate-500 w-3">{idx + 1}.</span>
                                        <span className={cn(
                                          "text-[10px] font-bold",
                                          darkMode ? "text-slate-300" : "text-slate-600"
                                        )}>{comp.name}</span>
                                        <span className="text-[8px] font-medium text-slate-400">{comp.symbol}</span>
                                      </div>
                                      <span className="text-[10px] font-black text-indigo-400">{comp.weight}%</span>
                                    </div>
                                  ))
                                ) : (
                                  <div className="px-1 py-1">
                                    <p className="text-[10px] text-slate-500 italic">尚未抓取到成分股資料，請點擊重新整理。</p>
                                  </div>
                                )}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>

                        <div className="grid grid-cols-2 gap-1.5 sm:gap-2">
                          <div className={cn(
                            "p-1.5 sm:p-2 rounded-xl transition-colors",
                            darkMode ? "bg-emerald-950/20" : "bg-emerald-50/30"
                          )}>
                            <p className="text-[7px] sm:text-[8px] font-bold text-emerald-500 uppercase truncate">今年已領</p>
                            <p className={cn(
                              "text-[10px] sm:text-xs font-bold whitespace-nowrap",
                              darkMode ? "text-emerald-400" : "text-emerald-700"
                            )}>
                              ${(((stock.dividendInfo as any).receivedAmountCurrentYear || (stock.dividendInfo as any).receivedAmount2026 || 0) * stock.shares).toLocaleString()}
                            </p>
                          </div>
                          <div className={cn(
                            "p-1.5 sm:p-2 rounded-xl transition-colors",
                            darkMode ? "bg-amber-950/20" : "bg-amber-50/30"
                          )}>
                            <p className="text-[7px] sm:text-[8px] font-bold text-amber-500 uppercase truncate">今年未領</p>
                            <p className={cn(
                              "text-[10px] sm:text-xs font-bold whitespace-nowrap",
                              darkMode ? "text-amber-400" : "text-amber-700"
                            )}>
                              ${(((stock.dividendInfo as any).pendingAmountCurrentYear || (stock.dividendInfo as any).pendingAmount2026 || 0) * stock.shares).toLocaleString()}
                            </p>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-1.5 sm:gap-2">
                          <div className={cn(
                            "p-1.5 sm:p-2 rounded-xl transition-colors",
                            darkMode ? "bg-slate-800" : "bg-slate-50"
                          )}>
                            <p className="text-[7px] sm:text-[8px] font-bold text-slate-400 uppercase truncate">除息日</p>
                            <p className={cn(
                              "text-[10px] sm:text-xs font-bold whitespace-nowrap",
                              darkMode ? "text-slate-200" : "text-slate-700"
                            )}>
                              {stock.dividendInfo.exDividendDate || '未定'}
                            </p>
                          </div>
                          <div className={cn(
                            "p-1.5 sm:p-2 rounded-xl transition-colors",
                            darkMode ? "bg-slate-800" : "bg-slate-50"
                          )}>
                            <p className="text-[7px] sm:text-[8px] font-bold text-slate-400 uppercase truncate">發放日</p>
                            <p className={cn(
                              "text-[10px] sm:text-xs font-bold whitespace-nowrap",
                              darkMode ? "text-slate-200" : "text-slate-700"
                            )}>
                              {stock.dividendInfo.paymentDate || '未定'}
                            </p>
                          </div>
                        </div>

                        <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
                          <div className={cn(
                            "p-1.5 sm:p-2 rounded-xl transition-colors",
                            darkMode ? "bg-slate-800" : "bg-slate-50"
                          )}>
                            <p className="text-[7px] sm:text-[8px] font-bold text-slate-400 uppercase truncate">現值</p>
                            <p className={cn(
                              "text-[10px] sm:text-xs font-bold whitespace-nowrap",
                              darkMode ? "text-slate-200" : "text-slate-700"
                            )}>
                              ${((stock.dividendInfo.currentPrice || 0) * stock.shares).toLocaleString()}
                            </p>
                          </div>
                          <div className={cn(
                            "p-1.5 sm:p-2 rounded-xl transition-colors",
                            darkMode ? "bg-slate-800" : "bg-slate-50"
                          )}>
                            <p className="text-[7px] sm:text-[8px] font-bold text-slate-400 uppercase truncate">殖利率</p>
                            <p className="text-[10px] sm:text-xs font-bold text-emerald-500 whitespace-nowrap">
                              {stock.dividendInfo.yield?.toFixed(2) || '0.00'}%
                            </p>
                          </div>
                          <div className={cn(
                            "p-1.5 sm:p-2 rounded-xl transition-colors",
                            darkMode ? "bg-slate-800" : "bg-slate-50"
                          )}>
                            <p className="text-[7px] sm:text-[8px] font-bold text-slate-400 uppercase truncate">佔比</p>
                            <p className="text-[10px] sm:text-xs font-bold text-indigo-500 whitespace-nowrap">
                              {portfolioData.totalValue > 0 
                                ? (((stock.dividendInfo.currentPrice || 0) * stock.shares / portfolioData.totalValue) * 100).toFixed(1) 
                                : '0.0'}%
                            </p>
                          </div>
                        </div>
                        
                        <div className="grid grid-cols-2 gap-2">
                          <div className={cn(
                            "flex items-center gap-2 p-2 rounded-xl transition-colors",
                            darkMode ? "bg-indigo-950/20" : "bg-indigo-50/30"
                          )}>
                            <div className="flex-1">
                              <p className="text-[8px] font-bold text-indigo-400 uppercase">持有股數</p>
                              <input
                                type="number"
                                defaultValue={stock.shares || ''}
                                onFocus={(e) => e.target.select()}
                                onBlur={(e) => handleUpdateShares(stock.symbol, e.target.value === '' ? 0 : Number(e.target.value))}
                                className={cn(
                                  "w-full text-xs font-bold bg-transparent border-none p-0 focus:ring-0 focus:outline-none",
                                  darkMode ? "text-slate-100" : "text-slate-700"
                                )}
                              />
                            </div>
                          </div>
                          <div className={cn(
                            "flex items-center gap-2 p-2 rounded-xl transition-colors",
                            darkMode ? "bg-emerald-950/20" : "bg-emerald-50/30"
                          )}>
                            <div className="flex-1">
                              <p className="text-[8px] font-bold text-emerald-500 uppercase">手動調整股息</p>
                              <input
                                type="number"
                                defaultValue={stock.manualDividendAdjustment ?? ''}
                                placeholder="自動計算"
                                onFocus={(e) => e.target.select()}
                                onBlur={(e) => handleUpdateManualAdjustment(stock.symbol, e.target.value === '' ? null : Number(e.target.value))}
                                className={cn(
                                  "w-full text-xs font-bold bg-transparent border-none p-0 focus:ring-0 focus:outline-none placeholder:text-slate-400/50",
                                  darkMode ? "text-slate-100" : "text-slate-700"
                                )}
                              />
                            </div>
                          </div>
                        </div>
                        
                        <div className={cn(
                          "flex items-center justify-between p-2 rounded-xl transition-colors",
                          darkMode ? "bg-indigo-950/20" : "bg-indigo-50/30"
                        )}>
                          <div className="flex-1">
                            <p className="text-[8px] font-bold text-indigo-400 uppercase">
                              {stock.manualDividendAdjustment !== null && stock.manualDividendAdjustment !== undefined ? '手動股息' : '本次預計領取'}
                            </p>
                            <p className={cn(
                              "text-xs font-black",
                              (stock.manualDividendAdjustment === null || stock.manualDividendAdjustment === undefined) && !stock.dividendInfo.exDividendDate?.startsWith(new Date().getFullYear().toString())
                                ? "text-slate-400 text-[10px]"
                                : "text-indigo-500"
                            )}>
                              {stock.manualDividendAdjustment !== null && stock.manualDividendAdjustment !== undefined ? (
                                `$${stock.manualDividendAdjustment.toLocaleString()}`
                              ) : (
                                stock.dividendInfo.exDividendDate?.startsWith(new Date().getFullYear().toString()) 
                                  ? `$${(stock.dividendInfo.amount * stock.shares).toLocaleString()}`
                                  : '尚未公佈'
                              )}
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 space-y-2">
                        <div className={cn(
                          "p-2 rounded-xl flex items-center justify-between transition-colors",
                          darkMode ? "bg-slate-800" : "bg-slate-50"
                        )}>
                          <p className="text-[10px] text-slate-500 font-medium italic">
                            無股息資訊，請點擊重新整理。
                          </p>
                          <div className="flex items-center gap-2">
                            <span className="text-[8px] font-bold text-slate-400 uppercase">股數</span>
                            <input
                              type="number"
                              defaultValue={stock.shares || ''}
                              onFocus={(e) => e.target.select()}
                              onBlur={(e) => handleUpdateShares(stock.symbol, e.target.value === '' ? 0 : Number(e.target.value))}
                              className={cn(
                                "w-16 text-xs font-bold rounded-lg px-2 py-1 focus:ring-1 focus:ring-indigo-500 focus:outline-none transition-colors",
                                darkMode ? "bg-slate-900 text-slate-100" : "bg-white/50 text-slate-700"
                              )}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </motion.div>
                ))
              )}
              </div>
            </motion.div>
          )}
        </div>

        {/* Portfolio Dashboard - Moved to bottom */}
        <div className={cn(
          "p-4 rounded-2xl shadow-sm border transition-colors flex flex-col",
          darkMode ? "bg-slate-800 border-slate-700" : "bg-white border-slate-100"
        )}>
          <div className="flex flex-col gap-2 mb-4 shrink-0">
            {/* Top row: Title/Dropdown on left, Export Button on right */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className={cn("text-sm font-black", darkMode ? "text-slate-100" : "text-slate-900")}>庫存分佈</h2>
                <select
                  value={componentLimit}
                  onChange={(e) => setComponentLimit(Number(e.target.value))}
                  className={cn(
                    "text-[10px] font-bold rounded-lg px-2 py-1 border-none focus:ring-0",
                    darkMode ? "bg-slate-700 text-slate-200" : "bg-slate-100 text-slate-600"
                  )}
                >
                  <option value={5}>Top 5</option>
                  <option value={10}>Top 10</option>
                  <option value={20}>Top 20</option>
                </select>
              </div>
              
              {stocks.length > 0 && (
                <button
                  onClick={handleExportCSV}
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-bold transition-all active:scale-95 shadow-sm border cursor-pointer",
                    darkMode 
                      ? "bg-slate-700 text-indigo-400 hover:bg-slate-600 border-slate-600/50" 
                      : "bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border-indigo-100/50"
                  )}
                >
                  <Download className="w-3 h-3" />
                  <span>匯出 CSV</span>
                </button>
              )}
            </div>
            
            {/* Stats info row */}
            <div className="flex flex-wrap items-center gap-3">
              <p className={cn("text-[10px] sm:text-xs font-bold", darkMode ? "text-slate-400" : "text-slate-500")}>
                平均殖利率: <span className="text-emerald-500 mr-2">{portfolioData.totalWeightedYield.toFixed(2)}%</span>
                總現值: <span className="text-indigo-500">${portfolioData.totalValue.toLocaleString()}</span>
              </p>
            </div>
          </div>

          {/* Cash & Assets Info Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4 p-3.5 rounded-2xl bg-slate-50/70 dark:bg-slate-900/60 border border-slate-200/50 dark:border-slate-800">
            {/* Stocks Assets */}
            <div className="flex flex-col">
              <span className="text-[10px] font-extrabold tracking-wider uppercase text-slate-600 dark:text-slate-300">我的證券 (Stocks)</span>
              <span className="text-sm font-black text-indigo-600 dark:text-indigo-400 mt-1">${portfolioData.totalValue.toLocaleString()}</span>
              {/* Progress indicator */}
              <div className="mt-1.5 h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800/80 overflow-hidden">
                <div 
                  className="h-full bg-indigo-500 dark:bg-indigo-400 rounded-full" 
                  style={{ width: `${portfolioData.totalValue + cash > 0 ? (portfolioData.totalValue / (portfolioData.totalValue + cash)) * 100 : 0}%` }}
                />
              </div>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 font-bold mt-1">
                佔總資產: {portfolioData.totalValue + cash > 0 ? ((portfolioData.totalValue / (portfolioData.totalValue + cash)) * 100).toFixed(1) : 0}%
              </span>
            </div>

            {/* Cash Assets */}
            <div className="flex flex-col relative group">
              <span className="text-[10px] font-extrabold tracking-wider uppercase text-slate-600 dark:text-slate-300">我的現金 (Cash)</span>
              {isEditingCash ? (
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="text-xs font-black text-emerald-600 dark:text-emerald-400">$</span>
                  <input
                    type="number"
                    value={cashInput}
                    onChange={(e) => setCashInput(e.target.value)}
                    onBlur={() => {
                      const value = cashInput === '' ? 0 : Number(cashInput);
                      handleUpdateCash(value);
                      setIsEditingCash(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const value = cashInput === '' ? 0 : Number(cashInput);
                        handleUpdateCash(value);
                        setIsEditingCash(false);
                      }
                    }}
                    autoFocus
                    placeholder="輸入現金金額"
                    onFocus={(e) => e.target.select()}
                    className={cn(
                      "w-28 text-xs font-bold rounded-lg px-2 py-0.5 border border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500",
                      darkMode ? "bg-slate-800 text-slate-200" : "bg-white text-slate-700"
                    )}
                  />
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-sm font-black text-emerald-600 dark:text-emerald-400">${cash.toLocaleString()}</span>
                  <button 
                    onClick={() => {
                      setCashInput(cash.toString());
                      setIsEditingCash(true);
                    }}
                    className={cn(
                      "text-[9px] font-black tracking-wider uppercase px-2 py-0.5 rounded-lg border shadow-sm transition-all active:scale-95",
                      darkMode 
                        ? "bg-slate-700 hover:bg-slate-600 text-slate-200 border-slate-600" 
                        : "bg-white hover:bg-slate-100 text-slate-700 border-slate-200"
                    )}
                  >
                    設定金額
                  </button>
                </div>
              )}
              {/* Progress indicator */}
              <div className="mt-1.5 h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800/80 overflow-hidden">
                <div 
                  className="h-full bg-emerald-500 dark:bg-emerald-400 rounded-full" 
                  style={{ width: `${portfolioData.totalValue + cash > 0 ? (cash / (portfolioData.totalValue + cash)) * 100 : 0}%` }}
                />
              </div>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 font-bold mt-1">
                佔總資產: {portfolioData.totalValue + cash > 0 ? ((cash / (portfolioData.totalValue + cash)) * 100).toFixed(1) : 0}%
              </span>
            </div>

            {/* Total Assets */}
            <div className="flex flex-col">
              <span className="text-[10px] font-extrabold tracking-wider uppercase text-slate-600 dark:text-slate-300">總資產價值 (Total Net Worth)</span>
              <span className={cn("text-sm font-black mt-1", darkMode ? "text-slate-100" : "text-slate-800")}>
                ${(portfolioData.totalValue + cash).toLocaleString()}
              </span>
              <div className="mt-1.5 h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800/80 overflow-hidden flex">
                <div 
                  className="h-full bg-indigo-500 dark:bg-indigo-400" 
                  style={{ width: `${portfolioData.totalValue + cash > 0 ? (portfolioData.totalValue / (portfolioData.totalValue + cash)) * 100 : 100}%` }}
                />
                <div 
                  className="h-full bg-emerald-500 dark:bg-emerald-400" 
                  style={{ width: `${portfolioData.totalValue + cash > 0 ? (cash / (portfolioData.totalValue + cash)) * 100 : 0}%` }}
                />
              </div>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 font-bold mt-1">證券 + 現金</span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1">
            {portfolioData.allocationData.map((item, index) => (
              <div key={index} className="flex justify-between items-center text-[10px] sm:text-[11px] py-1 border-b border-slate-100 dark:border-slate-700/50 last:border-0">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                  <span className={cn("font-bold truncate", darkMode ? "text-slate-300" : "text-slate-700")}>
                    {item.fullName}
                  </span>
                </div>
                <div className="flex items-center gap-2 sm:gap-4 font-mono shrink-0 ml-2 sm:ml-4">
                  <span className="text-emerald-500 font-bold w-10 sm:w-12 text-right">{item.yield.toFixed(1)}%</span>
                  <span className="text-indigo-500 font-bold w-16 sm:w-20 text-right">${item.value.toLocaleString()}</span>
                  <span className={cn("w-10 sm:w-12 text-right font-bold", darkMode ? "text-slate-500" : "text-slate-400")}>
                    {item.percentage.toFixed(1)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: ${darkMode ? '#334155' : '#E2E8F0'};
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: ${darkMode ? '#475569' : '#CBD5E1'};
        }
      `}</style>
      </div>
    </div>
  );
}
