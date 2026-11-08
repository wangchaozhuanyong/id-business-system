import { Transform, type TransformCallback } from 'node:stream';
import { BackupError } from './backup-types';

const OPEN = Buffer.from('/*!50003 ');
const TRIGGER = Buffer.from('/*!50003 TRIGGER ');
const BLOCK_DELIMITER = Buffer.from('DELIMITER ;;');
const RESET_DELIMITER = Buffer.from('DELIMITER ;');

/** MySQL bug 77856: unwrap trigger bodies without changing their SQL or the stored dump. */
export class MysqlTriggerRestoreFilter extends Transform {
  private pending = Buffer.alloc(0);
  private quote = 0;
  private lineComment = false;
  private blockComment = false;
  private trigger = false;
  private alternateDelimiter = false;
  private previousByte = 10;
  private triggerCount = 0;
  private delimiterCount = 0;
  summary() {
    return { triggers: this.triggerCount, delimiterBlocks: this.delimiterCount };
  }

  private consume(bytes: Buffer, final: boolean) {
    const data = Buffer.concat([this.pending, bytes]);
    const limit = final ? data.length : Math.max(0, data.length - 64);
    let index = 0,
      start = 0;
    const emit = (end: number) => {
      if (end > start) this.push(data.subarray(start, end));
    };
    while (index < limit) {
      const current = data[index]!,
        next = data[index + 1];
      if (this.quote) {
        if (current === 92 && this.quote !== 96 && next !== undefined) index += 2;
        else if (current === this.quote) {
          if (next === this.quote) index += 2;
          else {
            this.quote = 0;
            index++;
          }
        } else index++;
      } else if (this.lineComment) {
        if (current === 10 || current === 13) this.lineComment = false;
        index++;
      } else if (this.blockComment) {
        if (current === 42 && next === 47) {
          this.blockComment = false;
          index += 2;
        } else index++;
      } else if (
        (index === 0
          ? this.previousByte === 10 || this.previousByte === 13
          : data[index - 1] === 10 || data[index - 1] === 13) &&
        data.subarray(index, index + BLOCK_DELIMITER.length).equals(BLOCK_DELIMITER)
      ) {
        emit(index);
        this.push(Buffer.from('DELIMITER $$'));
        index += BLOCK_DELIMITER.length;
        start = index;
        this.alternateDelimiter = true;
        this.delimiterCount++;
      } else if (
        (index === 0
          ? this.previousByte === 10 || this.previousByte === 13
          : data[index - 1] === 10 || data[index - 1] === 13) &&
        data.subarray(index, index + RESET_DELIMITER.length).equals(RESET_DELIMITER)
      ) {
        this.alternateDelimiter = false;
        index += RESET_DELIMITER.length;
      } else if (this.trigger && current === 32 && next === 42 && data[index + 2] === 47) {
        // Remove exactly the one space introduced by mysqldump before the closing wrapper.
        emit(index);
        index += 3;
        start = index;
        this.trigger = false;
      } else if (this.trigger && current === 42 && next === 47) {
        emit(index);
        index += 2;
        start = index;
        this.trigger = false;
      } else if (!this.trigger && data.subarray(index, index + TRIGGER.length).equals(TRIGGER)) {
        emit(index);
        start = index + OPEN.length;
        index += TRIGGER.length;
        this.trigger = true;
        this.triggerCount++;
      } else if (!this.trigger && this.alternateDelimiter && current === 59 && next === 59) {
        emit(index);
        this.push(Buffer.from('$$'));
        index += 2;
        start = index;
      } else if (current === 47 && next === 42) {
        this.blockComment = true;
        index += 2;
      } else if (
        current === 35 ||
        (current === 45 && next === 45 && (data[index + 2] ?? 33) <= 32)
      ) {
        this.lineComment = true;
        index++;
      } else if (current === 39 || current === 34 || current === 96) {
        this.quote = current;
        index++;
      } else index++;
    }
    emit(index);
    if (index > 0) this.previousByte = data[index - 1]!;
    this.pending = Buffer.from(data.subarray(index));
    if (final && this.trigger) throw new BackupError('BACKUP_MYSQL_TRIGGER_DUMP_INCOMPLETE');
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
    try {
      this.consume(chunk, false);
      done();
    } catch (error) {
      done(error as Error);
    }
  }
  override _flush(done: TransformCallback) {
    try {
      this.consume(Buffer.alloc(0), true);
      done();
    } catch (error) {
      done(error as Error);
    }
  }
}
