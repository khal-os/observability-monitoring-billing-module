export interface Pagination {
  page: number;
  pageSize: number;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  /** Exact when totalCapped is false; the cap value when true. */
  total: number;
  /**
   * True when counting stopped at the cap (decision 77): exact totals on
   * arbitrary filter combos are O(matching docs) — displays show "10.000+".
   */
  totalCapped: boolean;
}
