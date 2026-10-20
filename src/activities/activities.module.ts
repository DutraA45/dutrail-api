import { Module } from '@nestjs/common';
import { ActivitiesController } from './activities.controller.js';
import { ActivitiesService } from './activities.service.js';
import { ActivityFileStorageService } from './storage/activity-file-storage.service.js';

@Module({
  controllers: [ActivitiesController],
  providers: [ActivitiesService, ActivityFileStorageService],
})
export class ActivitiesModule {}
