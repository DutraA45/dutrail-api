-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "fitFileKey" TEXT,
ADD COLUMN     "fitFingerprint" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Activity_fitFileKey_key" ON "Activity"("fitFileKey");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_userId_fitFingerprint_key" ON "Activity"("userId", "fitFingerprint");

