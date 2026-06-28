import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1782673690213 implements MigrationInterface {
  name = 'CreateVideos1782673690213';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('rascunho', 'aguardando_upload', 'processando', 'pronto', 'erro')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" character varying(21) NOT NULL, "channel_id" uuid NOT NULL, "title" character varying(255) NOT NULL DEFAULT '', "description" text, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'rascunho', "source_key" character varying(512) NOT NULL DEFAULT '', "thumbnail_key" character varying(512), "upload_id" character varying(128), "duration_seconds" numeric(10,3), "width" integer, "height" integer, "size_bytes" bigint, "mime_type" character varying(64), "failure_reason" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channel_id" ON "videos" ("channel_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_status" ON "videos" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channel_id_created_at" ON "videos" ("channel_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_videos_channel_id_created_at"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_channel_id"`);
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
