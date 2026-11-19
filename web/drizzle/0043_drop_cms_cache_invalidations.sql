-- The website's CMS cache table leaves chat's database. Nothing reads or writes it any more:
-- a CMS publish clears the receiving instance's own cache and purges the CDN by tag, and every other
-- instance refreshes on its TTL. www holds no grant on this database, and a self-hosted Alpha database
-- carries no website table. IF EXISTS, so a database that never had it migrates too.
DROP TABLE IF EXISTS "cms_cache_invalidations";
