-- CreateEnum
CREATE TYPE "ActivitySport" AS ENUM ('running', 'cycling', 'walking', 'hiking', 'swimming', 'other');

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sport" "ActivitySport" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "elapsedTimeSeconds" INTEGER NOT NULL,
    "movingTimeSeconds" INTEGER,
    "distanceMeters" DOUBLE PRECISION,
    "elevationGainMeters" DOUBLE PRECISION,
    "averageHeartRateBpm" INTEGER,
    "maxHeartRateBpm" INTEGER,
    "calories" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Activity_userId_startedAt_id_idx" ON "Activity"("userId", "startedAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
