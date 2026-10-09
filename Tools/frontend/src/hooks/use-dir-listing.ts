'use client';

/**
 * Nạp danh sách file theo TRANG, sắp xếp ở server.
 *
 * Bản cũ gọi `api.listFiles(serverId, path)` và nhận **toàn bộ** thư mục vào
 * React state, rồi sort + filter trên mảng đầy đủ ở mỗi lần render, rồi render
 * mọi dòng ra DOM. Thư mục vài chục nghìn file vì thế: JSON vài MB, một lần
 * sort toàn mảng mỗi lần gõ phím, và vài chục nghìn node DOM.
 *
 * Ở đây:
 * - server trả về ~1k dòng đầu đã sắp xếp sẵn, kèm `total` để UI biết còn bao nhiêu;
 * - cuộn tới cuối thì nạp thêm trang kế (`loadMore`);
 * - đổi cột sắp xếp là gọi lại server, không sort lại ở client;
 * - tìm kiếm trong thư mục hiện tại cũng do server lọc (nó giữ cache 15s nên
 *   gần như tức thì), còn tìm đệ quy thì dùng `searchFiles` + index.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type FileEntry, type ListFilesOptions } from '@/lib/api';

export const PAGE_SIZE = 1000;

export type SortKey = NonNullable<ListFilesOptions['sort']>;
export type SortOrder = NonNullable<ListFilesOptions['order']>;

export interface DirListing {
  entries: FileEntry[];
  /** Số entry khớp bộ lọc hiện tại. */
  total: number;
  /** Số entry thật trong thư mục. */
  totalUnfiltered: number;
  loading: boolean;
  /** Đang nạp thêm trang, khác với lần nạp đầu. */
  loadingMore: boolean;
  error: string | null;
  indexState: 'none' | 'running' | 'done' | 'failed';
  indexedEntries: number;
  hasMore: boolean;
}

const EMPTY: DirListing = {
  entries: [],
  total: 0,
  totalUnfiltered: 0,
  loading: false,
  loadingMore: false,
  error: null,
  indexState: 'none',
  indexedEntries: 0,
  hasMore: false,
};

export function useDirListing(serverId: string, path: string) {
  const [sort, setSort] = useState<SortKey>('name');
  const [order, setOrder] = useState<SortOrder>('asc');
  const [query, setQuery] = useState('');
  const [state, setState] = useState<DirListing>(EMPTY);

  // Mỗi lần nạp có một token riêng; phản hồi của lần nạp cũ bị bỏ qua.
  // Không có nó thì đổi thư mục nhanh sẽ khiến kết quả về sau ghi đè kết quả mới.
  const reqId = useRef(0);

  const load = useCallback(
    async (opts: { offset: number; append: boolean; refresh?: boolean }) => {
      if (!serverId || !path) {
        setState(EMPTY);
        return;
      }
      const id = ++reqId.current;
      setState((s) => ({
        ...s,
        loading: !opts.append,
        loadingMore: opts.append,
        error: null,
      }));

      try {
        const page = await api.listFiles(serverId, {
          path,
          offset: opts.offset,
          limit: PAGE_SIZE,
          sort,
          order,
          q: query.trim() || undefined,
          refresh: opts.refresh,
        });
        if (id !== reqId.current) return; // đã có yêu cầu mới hơn

        setState((s) => {
          const entries = opts.append ? [...s.entries, ...page.entries] : page.entries;
          return {
            entries,
            total: page.total,
            totalUnfiltered: page.totalUnfiltered,
            loading: false,
            loadingMore: false,
            error: null,
            indexState: page.indexState,
            indexedEntries: page.indexedEntries,
            hasMore: entries.length < page.total,
          };
        });
      } catch (e) {
        if (id !== reqId.current) return;
        setState((s) => ({
          ...s,
          loading: false,
          loadingMore: false,
          error: e instanceof Error ? e.message : 'không nạp được danh sách',
        }));
      }
    },
    [serverId, path, sort, order, query]
  );

  // Đổi thư mục / cột sắp xếp / từ khoá -> nạp lại từ đầu.
  // Debounce 180ms để gõ từ khoá không bắn một request mỗi ký tự.
  useEffect(() => {
    const t = setTimeout(() => load({ offset: 0, append: false }), query ? 180 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  const loadMore = useCallback(() => {
    setState((s) => {
      if (s.loading || s.loadingMore || !s.hasMore) return s;
      void load({ offset: s.entries.length, append: true });
      return s;
    });
  }, [load]);

  const refresh = useCallback(
    () => load({ offset: 0, append: false, refresh: true }),
    [load]
  );

  /** Bấm vào tiêu đề cột: cùng cột thì đảo chiều, khác cột thì đổi cột. */
  const toggleSort = useCallback(
    (key: SortKey) => {
      if (key === sort) {
        setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
      } else {
        setSort(key);
        // Tên thì a→z là tự nhiên; cỡ và ngày thì lớn/mới nhất trước mới hữu ích.
        setOrder(key === 'name' || key === 'type' ? 'asc' : 'desc');
      }
    },
    [sort]
  );

  return {
    ...state,
    sort,
    order,
    query,
    setQuery,
    toggleSort,
    loadMore,
    refresh,
  };
}

/**
 * Trạng thái index đệ quy của thư mục đang đứng, dùng cho tìm kiếm toàn subtree.
 * Tự hỏi lại server mỗi 1.5s trong lúc đang quét.
 */
export function useFileIndex(serverId: string, path: string) {
  const [state, setState] = useState<'none' | 'running' | 'done' | 'failed'>('none');
  const [entries, setEntries] = useState(0);

  const poll = useCallback(async () => {
    if (!serverId || !path) return 'none' as const;
    try {
      const s = await api.getIndexStatus(serverId, path);
      setState(s.state);
      setEntries(s.entries ?? 0);
      return s.state;
    } catch {
      return 'none' as const;
    }
  }, [serverId, path]);

  useEffect(() => {
    void poll();
  }, [poll]);

  useEffect(() => {
    if (state !== 'running') return;
    const t = setInterval(() => void poll(), 1500);
    return () => clearInterval(t);
  }, [state, poll]);

  const start = useCallback(async () => {
    if (!serverId || !path) return;
    setState('running');
    try {
      await api.startIndex(serverId, path);
    } catch {
      setState('failed');
    }
    void poll();
  }, [serverId, path, poll]);

  return { state, entries, start, refresh: poll };
}
