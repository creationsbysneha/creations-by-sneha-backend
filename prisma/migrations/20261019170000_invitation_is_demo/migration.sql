-- AlterTable
ALTER TABLE "invitations" ADD COLUMN "is_demo" BOOLEAN NOT NULL DEFAULT false;

UPDATE "invitations" SET "is_demo" = true WHERE "slug" = 'saanvi-and-kabir';
