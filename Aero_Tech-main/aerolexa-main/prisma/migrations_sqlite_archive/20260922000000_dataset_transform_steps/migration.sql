-- Dataset.transformSteps: persisted Power Query applied steps (JSON PQStep[]).
-- Dataset.connectorWatermark: incremental-sync watermark for connector-backed
-- datasets (JSON { column, value, colType }).
ALTER TABLE "Dataset" ADD COLUMN "transformSteps" TEXT;
ALTER TABLE "Dataset" ADD COLUMN "connectorWatermark" TEXT;
