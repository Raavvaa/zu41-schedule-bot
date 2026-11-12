INSERT OR IGNORE INTO deletion_watch(scope)
SELECT 'global:on' WHERE NOT EXISTS (
 SELECT 1 FROM deletion_watch WHERE scope IN ('global:on','global:off')
);
DELETE FROM deletion_watch WHERE scope NOT IN ('global:on','global:off');
