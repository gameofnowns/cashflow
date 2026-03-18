-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "external_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "project_type" TEXT NOT NULL,
    "confidence_tier" TEXT NOT NULL,
    "total_value" REAL,
    "status" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "payment_milestones" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "expected_date" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "invoice_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "payment_milestones_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "financial_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshot_date" DATETIME NOT NULL,
    "bank_balance" REAL,
    "total_ar" REAL,
    "total_ap" REAL,
    "source" TEXT NOT NULL DEFAULT 'exact',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "overhead_budget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "month" DATETIME NOT NULL,
    "amount" REAL NOT NULL,
    "notes" TEXT,
    "updated_by" TEXT,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_external_id_source_key" ON "projects"("external_id", "source");

-- CreateIndex
CREATE UNIQUE INDEX "overhead_budget_month_key" ON "overhead_budget"("month");
