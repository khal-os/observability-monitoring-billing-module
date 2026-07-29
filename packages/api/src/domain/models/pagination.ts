export interface Pagination {
  page: number;
  pageSize: number;
}

/**
 * One horizon for counting AND navigating (decision 77/79): counting
 * stops at this many documents, and so must skipping — skip() is an
 * O(skip) index walk per request, so an uncapped `page` param lets a
 * single curl loop hold the DB hostage at 1M docs. A page whose skip
 * would pass the horizon is a 400, mirroring the capped totals the
 * client already sees.
 */
export const MAX_PAGINATION_SKIP = 10_000;

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
