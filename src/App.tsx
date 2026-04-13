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
  PieChart
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
  const [isSyncing, setIsSyncing] = useState(false);
  const [expandedEtf, setExpandedEtf] = useState<Set<string>>(new Set());
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('dividend_dark_mode');
    return saved === 'true';
  });

  const handleSyncToCalendar = async (stock: StockEntry) => {
    if (!stock.dividendInfo?.exDividendDate && !stock.dividendInfo?.paymentDate) return;
    
    setIsSyncing(true);
    try {
      const response = await fetch('/api/auth/url');
      const { url } = await response.json();
      
      const authWindow = window.open(url, 'oauth_popup', 'width=600,height=700');
      
      const handleMessage = async (event: MessageEvent) => {
        if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
          window.removeEventListener('message', handleMessage);
          
          try {
            const syncPromises = [];
            
            // 1. 同步除息日 (Ex-dividend date)
            if (stock.dividendInfo?.exDividendDate) {
              syncPromises.push(
                fetch('/api/calendar/event', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    summary: `除息日: ${stock.name}`,
                    start: stock.dividendInfo.exDividendDate,
                    end: stock.dividendInfo.exDividendDate
                  })
                }).then(async res => {
                  if (!res.ok) {
                    const errorData = await res.json();
                    throw new Error(errorData.error || '除息日同步失敗');
                  }
                })
              );
            }
            
            // 2. 同步領息日 (Payment date)
            if (stock.dividendInfo?.paymentDate) {
              syncPromises.push(
                fetch('/api/calendar/event', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    summary: `領息日: ${stock.name}`,
                    start: stock.dividendInfo.paymentDate,
                    end: stock.dividendInfo.paymentDate
                  })
                }).then(async res => {
                  if (!res.ok) {
                    const errorData = await res.json();
                    throw new Error(errorData.error || '領息日同步失敗');
                  }
                })
              );
            }
            
            if (syncPromises.length === 0) {
              throw new Error('沒有除息日或領息日資料可供同步');
            }
            
            await Promise.all(syncPromises);
            
            alert('已成功將日期同步至 Google 行事曆');
          } catch (err) {
            console.error('Sync error:', err);
            alert(`同步失敗: ${err instanceof Error ? err.message : '未知錯誤'}`);
          }
        }
      };
      
      window.addEventListener('message', handleMessage);
    } catch (error) {
      console.error(error);
      alert('同步失敗');
    } finally {
      setIsSyncing(false);
    }
  };

  // Notification Helpers
  const requestNotificationPermission = async () => {
    if (typeof Notification === 'undefined') return;
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === 'granted') {
      new Notification('股息小幫手', {
        body: '通知功能已開啟！當有除息或領息事件時，我們會提醒您。',
        icon: '/favicon.ico'
      });
    }
  };

  const testNotification = () => {
    if (notificationPermission === 'granted') {
      new Notification('測試通知', {
        body: '這是一則測試通知，表示您的通知功能運作正常。',
        icon: '/favicon.ico'
      });
    } else {
      requestNotificationPermission();
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
          // Add a delay between requests to avoid rate limits (RPM)
          if (i > 0) await new Promise(resolve => setTimeout(resolve, 8000));
          
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
    if (notificationPermission !== 'granted' || stocks.length === 0) return;

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
  }, [notificationPermission, stocks, calendarEvents]);

  const dividendStats = useMemo(() => {
    const today = startOfToday();
    const currentYear = today.getFullYear();
    const startDate = new Date(currentYear, 0, 1); // e.g., 2026/01/01
    
    let received = 0;
    let pending = 0;
    let total = 0;
    const distribution: Record<string, number> = {};
    const monthlyTotals = Array(12).fill(0);

    stocks.forEach(stock => {
      if (stock.dividendInfo && stock.shares > 0) {
        let stockTotal = 0;
        const info = stock.dividendInfo;
        
        // Use manual adjustment if available
        if (stock.manualDividendAdjustment !== undefined && stock.manualDividendAdjustment !== null) {
          const amount = stock.manualDividendAdjustment;
          total += amount;
          // Manual adjustment is usually for dividends already received or specifically known
          received += amount; 
          stockTotal = amount;
          
          // For manual adjustment, we'll put it in the current month for the chart
          const currentMonthIdx = new Date().getMonth();
          monthlyTotals[currentMonthIdx] += amount;
        } else {
          // Support both old (2026) and new (CurrentYear) field names during transition
          const rAmount = ((info as any).receivedAmountCurrentYear || (info as any).receivedAmount2026 || 0) * stock.shares;
          const pAmount = ((info as any).pendingAmountCurrentYear || (info as any).pendingAmount2026 || 0) * stock.shares;
          
          received += rAmount;
          pending += pAmount;
          total += (rAmount + pAmount);
          stockTotal = rAmount + pAmount;

          // Monthly totals from AI distribution
          if (info.monthlyDistribution && Array.isArray(info.monthlyDistribution)) {
            info.monthlyDistribution.forEach((monthlyAmount, monthIdx) => {
              if (monthIdx < 12) {
                monthlyTotals[monthIdx] += monthlyAmount * stock.shares;
              }
            });
          } else if (info.paymentDate) {
            // Fallback to single payment date if monthlyDistribution is missing
            const pDate = parseISO(info.paymentDate);
            if (pDate.getFullYear() === currentYear) {
              const month = pDate.getMonth();
              monthlyTotals[month] += info.amount * stock.shares;
            }
          }
        }

        // Distribution data (using total for the pie chart to show overall contribution)
        if (stockTotal > 0) {
          distribution[stock.name] = (distribution[stock.name] || 0) + stockTotal;
        }
      }
    });

    const distributionData = Object.entries(distribution)
      .map(([name, value]) => ({ name, value }))
      .filter(item => item.value > 0)
      .sort((a, b) => b.value - a.value);

    const monthlyData = monthlyTotals.map((amount, index) => ({
      month: `${index + 1}月`,
      amount: Math.round(amount)
    }));

    return { received, pending, total, distributionData, monthlyData };
  }, [stocks]);

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

    const rawAllocationData = stocks.map(stock => {
      const marketValue = (stock.dividendInfo?.currentPrice || 0) * stock.shares;
      return {
        name: stock.symbol,
        fullName: stock.name,
        value: marketValue,
        percentage: totalValue > 0 ? (marketValue / totalValue) * 100 : 0,
        yield: stock.dividendInfo?.yield || 0
      };
    }).filter(item => item.value > 0).sort((a, b) => b.value - a.value);

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
              <div>
                <h1 className="text-lg font-black tracking-tight text-indigo-500 flex items-center gap-2">
                  <TrendingUp className="w-5 h-5" />
                  股息小幫手
                </h1>
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
                <button 
                  onClick={() => setShowAddForm(!showAddForm)}
                  className="p-2 bg-indigo-600 text-white rounded-full shadow-md active:scale-95 transition-transform"
                >
                  <Plus className="w-5 h-5" />
                </button>
                
                <div className="relative">
                  <button 
                    onClick={() => setShowSettings(!showSettings)}
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
                            "absolute right-0 mt-2 w-56 rounded-2xl shadow-xl border z-50 overflow-hidden",
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
                                "w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-bold transition-colors",
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

                            {/* API Usage Info */}
                            <div className={cn(
                              "px-3 py-2 border-t border-slate-100 dark:border-slate-800 mt-1",
                              darkMode ? "text-slate-300" : "text-slate-600"
                            )}>
                              <div className="flex justify-between items-center mb-1">
                                <p className="text-[10px] font-black uppercase tracking-wider opacity-50">今日 API 額度</p>
                                <span className={cn(
                                  "text-[10px] font-black",
                                  apiUsage.count > 80 ? "text-red-500" : apiUsage.count > 50 ? "text-amber-500" : "text-emerald-500"
                                )}>
                                  {apiUsage.count} / 100
                                </span>
                              </div>
                              <div className={cn(
                                "w-full h-1 rounded-full overflow-hidden",
                                darkMode ? "bg-slate-800" : "bg-slate-100"
                              )}>
                                <div 
                                  className={cn(
                                    "h-full transition-all duration-500",
                                    apiUsage.count > 80 ? "bg-red-500" : apiUsage.count > 50 ? "bg-amber-500" : "bg-emerald-500"
                                  )}
                                  style={{ width: `${Math.min(apiUsage.count, 100)}%` }}
                                />
                              </div>
                              <p className="text-[8px] opacity-40 mt-1 leading-tight">
                                註：此額度為 Google Search 每日搜尋限制。若額度用完，系統將自動切換至全域快取模式。
                              </p>
                            </div>

                            {/* Notification Settings */}
                            <div className={cn(
                              "px-3 py-2 border-t border-slate-100 dark:border-slate-800 mt-1",
                              darkMode ? "text-slate-300" : "text-slate-600"
                            )}>
                              <p className="text-[10px] font-black uppercase tracking-wider mb-2 opacity-50">通知設定</p>
                              <div className="flex flex-col gap-2">
                                {notificationPermission !== 'granted' ? (
                                  <button
                                    onClick={requestNotificationPermission}
                                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] font-bold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm active:scale-95"
                                  >
                                    <AlertCircle className="w-4 h-4" />
                                    <span>開啟桌面通知</span>
                                  </button>
                                ) : (
                                  <div className={cn(
                                    "flex items-center justify-between px-3 py-2 rounded-xl border transition-colors",
                                    darkMode ? "bg-slate-800/50 border-slate-700" : "bg-slate-50 border-slate-100"
                                  )}>
                                    <div className="flex items-center gap-2">
                                      <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                                      <span className="text-[11px] font-bold text-emerald-500">通知功能已啟用</span>
                                    </div>
                                    <button
                                      onClick={testNotification}
                                      className={cn(
                                        "px-2 py-1 rounded-lg text-[9px] font-black uppercase tracking-wider transition-colors",
                                        darkMode ? "bg-slate-700 text-slate-300 hover:bg-slate-600" : "bg-white text-slate-500 hover:bg-slate-100 border border-slate-200"
                                      )}
                                    >
                                      測試
                                    </button>
                                  </div>
                                )}
                                <p className="text-[10px] opacity-60 leading-relaxed px-1">
                                  開啟後，若當天有除息或領息事件，系統將於早上 8:00 自動彈出提醒。
                                </p>
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
                )}>年度總額</p>
                <p className={cn(
                  "text-sm font-black",
                  darkMode ? "text-slate-100" : "text-slate-900"
                )}>${dividendStats.total.toLocaleString()}</p>
              </div>

              <div className={cn(
                "p-2 rounded-xl border flex flex-col items-center text-center transition-colors",
                darkMode ? "bg-emerald-950/30 border-emerald-900/50" : "bg-emerald-50/50 border-emerald-100"
              )}>
                <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-wider">今年已領</p>
                <p className="text-sm font-black text-emerald-500">${dividendStats.received.toLocaleString()}</p>
              </div>

              <div className={cn(
                "p-2 rounded-xl border flex flex-col items-center text-center transition-colors",
                darkMode ? "bg-orange-950/30 border-orange-900/50" : "bg-orange-50/50 border-orange-100"
              )}>
                <p className="text-[9px] font-bold text-orange-500 uppercase tracking-wider">今年未領</p>
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
          <div className="flex justify-between items-center mb-2 shrink-0">
            <div className="flex flex-col">
              <h2 className={cn("text-sm font-black", darkMode ? "text-slate-100" : "text-slate-900")}>{new Date().getFullYear()} 股息概況</h2>
              <p className="text-[8px] text-slate-500 font-medium leading-tight">
                註：未來月份若未公佈配息則顯示為 0。
              </p>
            </div>
            <div className="flex gap-4">
              <p className={cn("text-[10px] sm:text-xs font-bold", darkMode ? "text-slate-400" : "text-slate-500")}>
                已領: <span className="text-emerald-500">${dividendStats.received.toLocaleString()}</span>
              </p>
              <p className={cn("text-[10px] sm:text-xs font-bold", darkMode ? "text-slate-400" : "text-slate-500")}>
                未領: <span className="text-amber-500">${dividendStats.pending.toLocaleString()}</span>
              </p>
            </div>
          </div>
          
          <div className="grid grid-cols-2 gap-2 sm:gap-8">
            {/* Pie Chart with Legend */}
            <div className="h-44 sm:h-64 flex flex-col">
              <ResponsiveContainer width="100%" height="100%">
                <RechartsPieChart margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                  <Pie
                    data={dividendStats.distributionData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="45%"
                    innerRadius="30%"
                    outerRadius="60%"
                    paddingAngle={2}
                    label={false}
                  >
                    {dividendStats.distributionData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip 
                    formatter={(value: number, name: string) => [`$${value.toLocaleString()}`, name]}
                    contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)', fontSize: '10px' }}
                  />
                  <Legend 
                    layout="horizontal" 
                    align="center" 
                    verticalAlign="bottom"
                    iconType="circle"
                    iconSize={4}
                    wrapperStyle={{ paddingTop: '10px' }}
                    formatter={(value: string) => (
                      <span className={cn(
                        "text-[8px] sm:text-[10px] font-bold truncate inline-block max-w-[50px] sm:max-w-[100px] align-middle",
                        darkMode ? "text-slate-400" : "text-slate-600"
                      )}>
                        {value}
                      </span>
                    )}
                  />
                </RechartsPieChart>
              </ResponsiveContainer>
            </div>

            {/* Monthly Bar Chart */}
            <div className={cn("pl-2 sm:pl-8 border-l flex flex-col h-44 sm:h-64", darkMode ? "border-slate-700" : "border-slate-100")}>
              <h3 className={cn("text-[9px] sm:text-[10px] font-bold mb-1 uppercase tracking-wider shrink-0", darkMode ? "text-slate-500" : "text-slate-400")}>每月股息</h3>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dividendStats.monthlyData} margin={{ top: 15, right: 0, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={darkMode ? "#334155" : "#e2e8f0"} />
                    <XAxis 
                      dataKey="month" 
                      axisLine={false} 
                      tickLine={false} 
                      interval={0}
                      tick={(props) => {
                        const { x, y, payload } = props;
                        // On very small screens, show every other month
                        const isSmall = typeof window !== 'undefined' && window.innerWidth < 400;
                        if (isSmall && parseInt(payload.value) % 2 === 0) return null;
                        
                        return (
                          <text x={x} y={y} dy={10} textAnchor="middle" fontSize={window.innerWidth > 640 ? 10 : 8} fontWeight={700} fill={darkMode ? "#94a3b8" : "#64748b"}>
                            {payload.value}
                          </text>
                        );
                      }}
                    />
                    <YAxis 
                      hide
                    />
                    <RechartsTooltip 
                      cursor={{ fill: darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.02)' }}
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          return (
                            <div className={cn(
                              "px-3 py-2 rounded-xl shadow-xl border text-[10px] font-bold",
                              darkMode ? "bg-slate-900 border-slate-800 text-slate-200" : "bg-white border-slate-100 text-slate-700"
                            )}>
                              <p className="mb-1 opacity-50">{payload[0].payload.month}</p>
                              <p className="text-emerald-500">股息: ${Number(payload[0].value).toLocaleString()}</p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Bar dataKey="amount" fill="#10b981" radius={[2, 2, 0, 0]}>
                      <LabelList 
                        dataKey="amount" 
                        position="top" 
                        formatter={(v: number) => v > 0 ? `${v >= 1000 ? (v/1000).toFixed(0) + 'k' : v}` : ''} 
                        style={{ fontSize: 7, fontWeight: 800, fill: darkMode ? '#10b981' : '#059669' }} 
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>

        {/* Add Stock Form - Compact */}
        <AnimatePresence>
          {showAddForm && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className={cn(
                "p-4 rounded-2xl shadow-sm border mb-4 transition-colors",
                darkMode ? "bg-slate-900 border-slate-800" : "bg-white border-slate-100"
              )}>
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder="輸入台股代號 (如: 2330)"
                      value={newSymbol}
                      onChange={(e) => setNewSymbol(e.target.value)}
                      className={cn(
                        "w-full pl-9 pr-4 py-2 border-none rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 transition-all",
                        darkMode ? "bg-slate-800 text-slate-100 placeholder:text-slate-500" : "bg-slate-50 text-slate-900"
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
                          className="text-[10px] font-bold text-slate-500 hover:text-slate-700"
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
                            "w-full px-3 py-2 rounded-xl text-xs font-bold outline-none",
                            darkMode ? "bg-slate-800 text-slate-100" : "bg-slate-50 text-slate-900"
                          )}
                        />
                        <input
                          type="number"
                          step="0.01"
                          placeholder="單次配息金額"
                          value={manualAmount}
                          onChange={(e) => setManualAmount(e.target.value)}
                          className={cn(
                            "w-full px-3 py-2 rounded-xl text-xs font-bold outline-none",
                            darkMode ? "bg-slate-800 text-slate-100" : "bg-slate-50 text-slate-900"
                          )}
                        />
                        <input
                          type="number"
                          step="0.1"
                          placeholder="目前股價 (選填)"
                          value={manualPrice}
                          onChange={(e) => setManualPrice(e.target.value)}
                          className={cn(
                            "w-full px-3 py-2 rounded-xl text-xs font-bold outline-none",
                            darkMode ? "bg-slate-800 text-slate-100" : "bg-slate-50 text-slate-900"
                          )}
                        />
                        <input
                          type="number"
                          step="0.001"
                          placeholder="持有股數"
                          value={newShares || ''}
                          onChange={(e) => setNewShares(e.target.value === '' ? 0 : Number(e.target.value))}
                          className={cn(
                            "w-full px-3 py-2 rounded-xl text-xs font-bold outline-none",
                            darkMode ? "bg-slate-800 text-slate-100" : "bg-slate-50 text-slate-900"
                          )}
                        />
                      </div>
                      <button
                        onClick={handleManualAdd}
                        disabled={isLoading || !newSymbol || !manualName || !manualAmount}
                        className="w-full py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold shadow-sm"
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
                            "w-full pl-9 pr-4 py-2 border-none rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 transition-all",
                            darkMode ? "bg-slate-800 text-slate-100 placeholder:text-slate-500" : "bg-slate-50 text-slate-900"
                          )}
                        />
                      </div>
                      <button
                        onClick={handleAddStock}
                        disabled={isLoading || !newSymbol}
                        className="px-6 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold shadow-sm disabled:opacity-50 active:scale-95 transition-all flex items-center gap-2"
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
                        className="text-[10px] font-bold text-indigo-500 underline"
                      >
                        點此切換至「手動輸入」模式
                      </button>
                    )}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

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
                {calendarEvents
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
              className="grid grid-cols-1 gap-3"
            >
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
                              <span>更新於: {new Date(stock.dividendInfo.updatedAt).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
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
                          onClick={() => {
                            console.log('Sync button clicked for:', stock.symbol);
                            handleSyncToCalendar(stock);
                          }}
                          disabled={isSyncing || (!stock.dividendInfo?.exDividendDate && !stock.dividendInfo?.paymentDate)}
                          className={cn(
                            "p-1.5 rounded-lg transition-colors relative z-10",
                            darkMode ? "text-slate-400 hover:bg-slate-800" : "text-slate-400 hover:bg-slate-100",
                            (isSyncing || (!stock.dividendInfo?.exDividendDate && !stock.dividendInfo?.paymentDate)) && "opacity-50 cursor-not-allowed"
                          )}
                          title={(!stock.dividendInfo?.exDividendDate && !stock.dividendInfo?.paymentDate) ? "無日期資料可同步" : "同步至行事曆"}
                        >
                          <CalendarIcon className="w-3.5 h-3.5" />
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
                                <p className="text-[8px] font-black text-indigo-500 uppercase tracking-wider px-1">前十大成分股</p>
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
                            <p className="text-xs font-black text-indigo-500">
                              ${((stock.manualDividendAdjustment !== null && stock.manualDividendAdjustment !== undefined)
                                ? stock.manualDividendAdjustment 
                                : (stock.dividendInfo.amount * stock.shares)).toLocaleString()}
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
            </motion.div>
          )}
        </div>

        {/* Portfolio Dashboard - Moved to bottom */}
        <div className={cn(
          "p-4 rounded-2xl shadow-sm border transition-colors flex flex-col",
          darkMode ? "bg-slate-800 border-slate-700" : "bg-white border-slate-100"
        )}>
          <div className="flex justify-between items-center mb-4 shrink-0">
            <h2 className={cn("text-sm font-black", darkMode ? "text-slate-100" : "text-slate-900")}>庫存分佈</h2>
            <div className="flex items-center gap-2">
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
              <p className={cn("text-xs font-bold", darkMode ? "text-slate-400" : "text-slate-500")}>
                平均殖利率: <span className="text-emerald-500 mr-2">{portfolioData.totalWeightedYield.toFixed(2)}%</span>
                總現值: <span className="text-indigo-500">${portfolioData.totalValue.toLocaleString()}</span>
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
            {portfolioData.allocationData.map((item, index) => (
              <div key={index} className="flex justify-between items-center text-[11px] py-1 border-b border-slate-100 dark:border-slate-700/50 last:border-0">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                  <span className={cn("font-bold truncate", darkMode ? "text-slate-300" : "text-slate-700")}>
                    {item.fullName}
                  </span>
                </div>
                <div className="flex items-center gap-4 font-mono shrink-0 ml-4">
                  <span className="text-emerald-500 font-bold w-12 text-right">{item.yield.toFixed(1)}%</span>
                  <span className="text-indigo-500 font-bold w-20 text-right">${item.value.toLocaleString()}</span>
                  <span className={cn("w-12 text-right font-bold", darkMode ? "text-slate-500" : "text-slate-400")}>
                    {item.percentage.toFixed(1)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>

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
  );
}
