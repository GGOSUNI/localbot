/** 룰렛 공용 타입 (DESIGN.md §4) */

export interface RouletteItem {
  label: string;
  weight: number;
  /** null = 무제한. 0이 되면 더 이상 안 나옴 */
  stock: number | null;
}

export type RouletteTrigger =
  | { type: 'per-amount'; price: number; maxPerDonation: number; carry: boolean }
  | { type: 'exact'; amount: number }
  | { type: 'manual' };

export interface Roulette {
  id: number;
  name: string;
  items: RouletteItem[];
  trigger: RouletteTrigger;
  enabled: boolean;
  chatTemplate: string;
  trackPenalties: boolean;
  sortOrder: number;
}

export interface Spin {
  id: number;
  rouletteId: number;
  rouletteName: string;
  viewerName: string | null;
  amountKRW: number;
  /** 결과 라벨 (연속 회전이면 여러 개) */
  results: string[];
  /** 결과 당시 항목 (오버레이가 원판을 그대로 그리기 위함) */
  items: RouletteItem[];
  createdAt: number;
  status: 'queued' | 'showing' | 'done';
}

export interface Penalty {
  id: number;
  spinId: number;
  label: string;
  viewerName: string | null;
  done: boolean;
  createdAt: number;
}

export interface RouletteState {
  roulettes: Roulette[];
  recentSpins: Spin[];
  penalties: Penalty[];
  overlayOnline: boolean;
  pendingShows: number;
}
