import { BadRequestException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants } from 'node:fs';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { resolve, join, sep, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { OnlineRechargeWorkerRpc } from '../contracts';
import { OnlineRechargeWorkerRepository } from './worker.repository';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { id, object, text } from '../validation';
import type { AuthenticatedUser } from '../../../auth/auth.types';

@Injectable()
export class OnlineRechargeArtifactsRepository {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly workers: OnlineRechargeWorkerRepository,
    private readonly config: ConfigService
  ) {}
  private async root() {
    const projectRoot = resolve(__dirname, '../../../../../..');
    const directory = resolve(
      this.config.get<string>('ONLINE_RECHARGE_ARTIFACT_DIR') ||
        join(projectRoot, '.runtime/online-recharge/artifacts')
    );
    if (!directory.startsWith(projectRoot + sep))
      throw new BadRequestException('运行资料目录必须属于当前项目');
    const canonicalProject = await realpath(projectRoot);
    let ancestor = directory;
    while (true) {
      try {
        const canonical = await realpath(ancestor);
        if (canonical !== canonicalProject && !canonical.startsWith(canonicalProject + sep))
          throw new BadRequestException('运行资料目录链接不能越过当前项目');
        break;
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
          throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw new BadRequestException('运行资料目录不可用');
        ancestor = parent;
      }
    }
    return directory;
  }
  async upload(rpc: OnlineRechargeWorkerRpc) {
    const input = rpc.args ?? {};
    if (input.redacted !== true || !['screenshot', 'video'].includes(String(input.kind)))
      throw new BadRequestException('仅允许已脱敏的截图和录像');
    const mimeType = text(input.mimeType, '文件类型', 80);
    const extension = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'video/mp4': '.mp4',
      'video/webm': '.webm'
    }[mimeType];
    if (!extension || (input.kind === 'screenshot') !== mimeType.startsWith('image/'))
      throw new BadRequestException('运行资料类型无效');
    if (typeof input.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64))
      throw new BadRequestException('文件内容格式无效');
    const maxBytes = input.kind === 'screenshot' ? 10 * 1024 * 1024 : 100 * 1024 * 1024;
    if (input.dataBase64.length > Math.ceil((maxBytes * 4) / 3) + 4)
      throw new BadRequestException('运行资料超过大小限制');
    const bytes = Buffer.from(input.dataBase64, 'base64');
    if (!bytes.length || bytes.length > maxBytes)
      throw new BadRequestException('运行资料为空或过大');
    const artifactId = randomUUID(),
      filename = artifactId + extension;
    const metadata = {
      id: artifactId,
      name: text(input.name ?? filename, '文件名', 200),
      kind: String(input.kind),
      mimeType,
      filename,
      size: bytes.length,
      downloadPath: `/id-business-v2/online-recharge/admin/artifacts/${artifactId}`
    };
    return this.workers.withLease(rpc, async (tx, row) => {
      await mkdir(await this.root(), { recursive: true });
      await writeFile(join(await this.root(), filename), bytes, { flag: 'wx', mode: 0o600 });
      await tx.onlineRechargeEvent.create({
        data: {
          id: artifactId,
          taskId: row.id,
          stage: 'artifact',
          message: '已保存脱敏运行资料',
          metadata: metadata as Prisma.InputJsonValue
        }
      });
      return metadata;
    });
  }
  async list(taskId: string) {
    const rows = await this.repository.read((db) =>
      db.onlineRechargeEvent.findMany({
        where: { taskId, stage: 'artifact' },
        orderBy: { createdAt: 'asc' }
      })
    );
    return {
      files: rows.map((row) => {
        const item = object(row.metadata);
        return { id: row.id, name: item.name, kind: item.kind, downloadPath: item.downloadPath };
      })
    };
  }
  async download(artifactId: string, operator: AuthenticatedUser) {
    const row = await this.repository.read((db) =>
      db.onlineRechargeEvent.findFirst({ where: { id: id(artifactId), stage: 'artifact' } })
    );
    if (!row) throw new NotFoundException('运行资料不存在');
    const metadata = object(row.metadata),
      filename = text(metadata.filename, '文件', 60);
    if (!/^[0-9a-f-]{36}\.(png|jpg|mp4|webm)$/.test(filename))
      throw new NotFoundException('运行资料无效');
    const file = await open(
      join(await this.root(), filename),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      await this.repository.transaction(`artifact:${artifactId}`, (tx) =>
        this.repository.log(tx, 'artifacts.download', operator, artifactId, { taskId: row.taskId })
      );
      return new StreamableFile(file.createReadStream(), {
        type: String(metadata.mimeType),
        disposition: `attachment; filename="${filename}"`
      });
    } catch (error) {
      await file.close();
      throw error;
    }
  }
}
