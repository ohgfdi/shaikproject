-- Add state field to PayrollRun for state-specific calculations (professional tax, etc.)
ALTER TABLE "PayrollRun" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'Maharashtra';

-- Create index for state-based queries
CREATE INDEX "PayrollRun_bookId_state_idx" ON "PayrollRun"("bookId", "state");
