-- AlterTable
ALTER TABLE "payment_milestones" ADD COLUMN     "label" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "actual_dispatch" TIMESTAMP(3),
ADD COLUMN     "approved_shops_date" TIMESTAMP(3),
ADD COLUMN     "contract_deadline" TIMESTAMP(3),
ADD COLUMN     "due_date" TIMESTAMP(3),
ADD COLUMN     "due_date_shops" TIMESTAMP(3),
ADD COLUMN     "leadtime_weeks" DOUBLE PRECISION,
ADD COLUMN     "payment_terms" TEXT,
ADD COLUMN     "prod_finished_date" TIMESTAMP(3),
ADD COLUMN     "production_eta" TIMESTAMP(3),
ADD COLUMN     "quote_date" TIMESTAMP(3),
ADD COLUMN     "record_set_status" TEXT,
ADD COLUMN     "shops_status" TEXT;

-- CreateTable
CREATE TABLE "ar_line_items" (
    "id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "description" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "invoice_date" TIMESTAMP(3) NOT NULL,
    "due_date" TIMESTAMP(3) NOT NULL,
    "currency_code" TEXT NOT NULL,
    "job_no" TEXT,
    "project_id" TEXT,
    "match_status" TEXT NOT NULL DEFAULT 'unmatched',
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ar_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ar_line_items_invoice_number_snapshot_date_key" ON "ar_line_items"("invoice_number", "snapshot_date");

-- AddForeignKey
ALTER TABLE "ar_line_items" ADD CONSTRAINT "ar_line_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
