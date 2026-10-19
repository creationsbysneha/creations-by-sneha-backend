-- AlterTable
ALTER TABLE "media" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ready',
ADD COLUMN "owner_invitation_id" TEXT,
ADD COLUMN "purpose" TEXT NOT NULL DEFAULT '',
ADD COLUMN "checksum" TEXT;

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN "published_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "published_slug" TEXT,
ADD COLUMN "published_key" TEXT;

-- CreateTable
CREATE TABLE "invitation_publications" (
    "id" TEXT NOT NULL,
    "invitation_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "object_key" TEXT NOT NULL,
    "media_ids" JSONB NOT NULL DEFAULT '[]',
    "asset_keys" JSONB NOT NULL DEFAULT '[]',
    "snapshot" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "actor" TEXT NOT NULL DEFAULT '',
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMP(3),

    CONSTRAINT "invitation_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_status_created_at_idx" ON "media"("status", "created_at");

-- CreateIndex
CREATE INDEX "media_owner_invitation_id_idx" ON "media"("owner_invitation_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_publications_invitation_id_version_key" ON "invitation_publications"("invitation_id", "version");

-- CreateIndex
CREATE INDEX "invitation_publications_state_idx" ON "invitation_publications"("state");
