// Catalog's view of Media: ids in, readable URLs out. Narrower than `MediaFacade` on purpose —
// the read path has no business attaching or detaching anything.
export const MEDIA_QUERY = Symbol('CATALOG_MEDIA_QUERY');

export interface MediaQueryPort {
  /**
   * URLs for many assets in one call, keyed by asset id; an id with no live asset is absent.
   *
   * Called after the cache read, never before: a resolved URL can expire, and a cached one would
   * outlive its signature.
   */
  resolveUrls(assetIds: string[]): Promise<Map<string, string>>;
}
