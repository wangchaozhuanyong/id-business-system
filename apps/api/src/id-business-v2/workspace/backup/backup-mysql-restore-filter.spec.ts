import { describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MysqlTriggerRestoreFilter } from './backup-mysql-restore-filter';

async function filtered(text: string, width = 65536) {
  const bytes = Buffer.from(text),
    output: Buffer[] = [];
  const input: Buffer[] = [];
  for (let index = 0; index < bytes.length; index += width)
    input.push(bytes.subarray(index, index + width));
  await pipeline(
    Readable.from(input),
    new MysqlTriggerRestoreFilter(),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        output.push(Buffer.from(chunk));
        done();
      }
    })
  );
  return Buffer.concat(output).toString('utf8');
}
const body =
  "TRIGGER `audit_guard` BEFORE UPDATE ON `audit_logs` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'immutable';";
const prefix = '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`%`*/ ';

describe('native MySQL trigger restore compatibility', () => {
  it('preserves the exact trigger body and definer while unwrapping only the affected comment', async () => {
    const original = `DELIMITER ;;\n${prefix}/*!50003 ${body} */;;\nDELIMITER ;\n`;
    const expected = `DELIMITER ;;\n${prefix}${body};;\nDELIMITER ;\n`;
    for (const width of [1, 2, 7, 63, 64, 65, 65536])
      expect(await filtered(original, width)).toBe(expected);
  });
  it('leaves business values, executable SET comments and Unicode bytes unchanged', async () => {
    const original =
      "/*!40101 SET NAMES utf8mb4 */;\nINSERT INTO `notes` VALUES('/*!50003 TRIGGER fake */', '中文🙂', 'escaped \\' quote');\n-- /*!50003 TRIGGER fake */\n";
    expect(await filtered(original, 1)).toBe(original);
  });
  it('retains compound bodies, internal comments and quoted closing markers', async () => {
    const trigger =
      "TRIGGER `guard` BEFORE UPDATE ON `t` FOR EACH ROW BEGIN\n  /* retained */\n  SET NEW.`note` = 'inside */; marker';\nEND";
    expect(await filtered(`${prefix}/*!50003 ${trigger} */;;\n`, 3)).toBe(
      `${prefix}${trigger};;\n`
    );
  });
  it('fails closed when the affected trigger wrapper is truncated', async () => {
    await expect(filtered(`${prefix}/*!50003 ${body}`, 2)).rejects.toThrow(
      'BACKUP_MYSQL_TRIGGER_DUMP_INCOMPLETE'
    );
  });
});
