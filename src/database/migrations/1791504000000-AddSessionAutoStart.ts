import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds `sessions.autoStart`, which records whether a session should be running so that a gateway
 * restart can start it again. Nullable with no default: existing rows stay null and are resolved
 * from their last status by SessionService on the first startup that sees them.
 */
export class AddSessionAutoStart1791504000000 implements MigrationInterface {
  name = 'AddSessionAutoStart1791504000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('sessions', 'autoStart')) return;

    await queryRunner.addColumn(
      'sessions',
      new TableColumn({ name: 'autoStart', type: 'boolean', isNullable: true, default: null }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('sessions', 'autoStart'))) return;

    await queryRunner.dropColumn('sessions', 'autoStart');
  }
}
