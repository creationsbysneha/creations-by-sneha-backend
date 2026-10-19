-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "admins" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled invitation',
    "template" TEXT NOT NULL DEFAULT 'classic-envelope',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "description" TEXT NOT NULL DEFAULT '',
    "bride_name" TEXT NOT NULL DEFAULT '',
    "bride_full" TEXT NOT NULL DEFAULT '',
    "bride_parents" TEXT NOT NULL DEFAULT '',
    "bride_grandparents" TEXT NOT NULL DEFAULT '',
    "groom_name" TEXT NOT NULL DEFAULT '',
    "groom_full" TEXT NOT NULL DEFAULT '',
    "groom_parents" TEXT NOT NULL DEFAULT '',
    "groom_grandparents" TEXT NOT NULL DEFAULT '',
    "families" TEXT NOT NULL DEFAULT '',
    "blessing" TEXT NOT NULL DEFAULT '',
    "compliment_one" TEXT NOT NULL DEFAULT '',
    "compliment_two" TEXT NOT NULL DEFAULT '',
    "rsvp_family" TEXT NOT NULL DEFAULT '',
    "cousins_label" TEXT NOT NULL DEFAULT '',
    "cousins" TEXT NOT NULL DEFAULT '',
    "wedding_at" TIMESTAMP(3),
    "venue_name" TEXT NOT NULL DEFAULT '',
    "venue_address_1" TEXT NOT NULL DEFAULT '',
    "venue_address_2" TEXT NOT NULL DEFAULT '',
    "venue_note" TEXT NOT NULL DEFAULT '',
    "map_embed" TEXT NOT NULL DEFAULT '',
    "directions_url" TEXT NOT NULL DEFAULT '',
    "rsvp_mode" TEXT NOT NULL DEFAULT 'disabled',
    "theme" JSONB NOT NULL,
    "guess_options" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "invitation_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "subtitle" TEXT NOT NULL DEFAULT '',
    "date_label" TEXT NOT NULL DEFAULT '',
    "venue" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "image_alt" TEXT NOT NULL DEFAULT '',
    "details" JSONB NOT NULL,
    "media_id" TEXT,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation_media" (
    "id" TEXT NOT NULL,
    "invitation_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "alt" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "invitation_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_admin_id_idx" ON "sessions"("admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_slug_key" ON "invitations"("slug");

-- CreateIndex
CREATE INDEX "events_invitation_id_sort_order_idx" ON "events"("invitation_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "media_storage_key_key" ON "media"("storage_key");

-- CreateIndex
CREATE INDEX "invitation_media_invitation_id_role_sort_order_idx" ON "invitation_media"("invitation_id", "role", "sort_order");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_media" ADD CONSTRAINT "invitation_media_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_media" ADD CONSTRAINT "invitation_media_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

