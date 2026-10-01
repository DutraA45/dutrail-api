-- Famílias de refresh tokens (A-04) e rotação transacional (A-17).
--
-- O SQL gerado pelo Prisma criava "familyId" já NOT NULL, o que falha com
-- linhas existentes. Aqui a coluna nasce nula, recebe um valor por linha e só
-- então vira NOT NULL.

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "familyId" UUID,
ADD COLUMN     "graceUsedAt" TIMESTAMP(3),
ADD COLUMN     "rotatedAt" TIMESTAMP(3),
ADD COLUMN     "successorId" TEXT;

-- Backfill: não há como reconstruir as cadeias de rotação antigas, então cada
-- token existente vira a sua própria família. Um token antigo já revogado que
-- volte a aparecer derruba só a si mesmo.
UPDATE "RefreshToken" SET "familyId" = gen_random_uuid() WHERE "familyId" IS NULL;

ALTER TABLE "RefreshToken" ALTER COLUMN "familyId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");
