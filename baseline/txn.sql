\set doc_id random(1,1000000)
\set points random(1,100)

INSERT INTO baseline_documents (id, document_type, comercio_id, payload, updated_at)
VALUES ('pgbench:' || :doc_id, 'pesaje', 'comercio:' || (:doc_id % 1000), jsonb_build_object('points', :points), now())
ON CONFLICT (id) DO UPDATE
SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at;

SELECT payload
FROM baseline_documents
WHERE document_type = 'pesaje'
  AND comercio_id = 'comercio:' || (:doc_id % 1000)
LIMIT 1;
