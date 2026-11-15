-- AlterTable
ALTER TABLE "invitations" ADD COLUMN "name_order" TEXT NOT NULL DEFAULT 'bride-first',
ADD COLUMN "bride_bio" TEXT NOT NULL DEFAULT '',
ADD COLUMN "groom_bio" TEXT NOT NULL DEFAULT '',
ADD COLUMN "invocation" TEXT NOT NULL DEFAULT '',
ADD COLUMN "rsvp_phone" TEXT NOT NULL DEFAULT '';
