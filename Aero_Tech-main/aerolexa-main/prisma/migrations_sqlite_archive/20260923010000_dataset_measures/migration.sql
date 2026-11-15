-- Dataset.measures: persistent named DAX measures (JSON { name → expression }) —
-- Power BI "model measures": defined once on the dataset, reused in any visual.
ALTER TABLE "Dataset" ADD COLUMN "measures" TEXT;
