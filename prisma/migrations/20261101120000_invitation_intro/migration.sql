-- AlterTable
ALTER TABLE "invitations" ADD COLUMN "intro_opening" TEXT NOT NULL DEFAULT '',
ADD COLUMN "intro_request" TEXT NOT NULL DEFAULT '',
ADD COLUMN "intro_occasion" TEXT NOT NULL DEFAULT '',
ADD COLUMN "intro_closing" TEXT NOT NULL DEFAULT '';
