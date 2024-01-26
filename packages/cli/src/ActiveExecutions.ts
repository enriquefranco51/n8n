import { Service } from 'typedi';
import type PCancelable from 'p-cancelable';
import type {
	IDeferredPromise,
	IExecuteResponsePromiseData,
	IRun,
	ExecutionStatus,
	WorkflowExecuteMode,
} from 'n8n-workflow';
import { ApplicationError, createDeferredPromise, sleep } from 'n8n-workflow';

import config from '@/config';
import { ConcurrencyQueue } from '@/ConcurrencyQueue';
import type {
	ExecutionPayload,
	IExecutingWorkflowData,
	IExecutionDb,
	IExecutionsCurrentSummary,
	IWorkflowExecutionDataProcess,
} from '@/Interfaces';
import { isWorkflowIdValid } from '@/utils';
import { ExecutionRepository } from '@db/repositories/execution.repository';
import { Logger } from '@/Logger';

@Service()
export class ActiveExecutions {
	private queues = {
		manual: new ConcurrencyQueue(config.getEnv('executions.manualConcurrency')),
		others: new ConcurrencyQueue(config.getEnv('executions.concurrency')),
	};

	private activeExecutions: {
		[executionId: string]: IExecutingWorkflowData;
	} = {};

	constructor(
		private readonly logger: Logger,
		private readonly executionRepository: ExecutionRepository,
	) {}

	/**
	 * Add a new active execution
	 */
	async add(executionData: IWorkflowExecutionDataProcess, executionId?: string): Promise<string> {
		let executionStatus: ExecutionStatus;
		if (executionId === undefined) {
			// Is a new execution so save in DB
			executionStatus = 'new';
			const fullExecutionData: ExecutionPayload = {
				data: executionData.executionData!,
				mode: executionData.executionMode,
				finished: false,
				startedAt: new Date(),
				workflowData: executionData.workflowData,
				status: executionStatus,
				workflowId: executionData.workflowData.id,
			};

			if (executionData.retryOf !== undefined) {
				fullExecutionData.retryOf = executionData.retryOf.toString();
			}

			const workflowId = executionData.workflowData.id;
			if (workflowId !== undefined && isWorkflowIdValid(workflowId)) {
				fullExecutionData.workflowId = workflowId;
			}

			executionId = await this.executionRepository.createNewExecution(fullExecutionData);
			if (executionId === undefined) {
				throw new ApplicationError('There was an issue assigning an execution id to the execution');
			}
		} else {
			// TODO: updating the status should happen after the concurrency check
			// Is an existing execution we want to finish so update in DB
			executionStatus = 'running';
			const execution: Pick<IExecutionDb, 'id' | 'data' | 'waitTill' | 'status'> = {
				id: executionId,
				data: executionData.executionData!,
				waitTill: null,
				status: executionStatus,
			};

			await this.executionRepository.updateExistingExecution(executionId, execution);
		}

		return await this.enqueue(executionId, executionData, executionStatus);
	}

	async enqueue(
		executionId: string,
		executionData: IWorkflowExecutionDataProcess,
		executionStatus: ExecutionStatus,
	) {
		// Wait here in-case execution concurrency limit is reached
		await this.getQueue(executionData.executionMode).enqueue(executionId);

		this.activeExecutions[executionId] = {
			executionData,
			startedAt: new Date(),
			postExecutePromises: [],
			status: executionStatus,
		};

		return executionId;
	}

	/**
	 * Attaches an execution
	 */
	attachWorkflowExecution(executionId: string, workflowExecution: PCancelable<IRun>) {
		this.getExecution(executionId).workflowExecution = workflowExecution;
	}

	attachResponsePromise(
		executionId: string,
		responsePromise: IDeferredPromise<IExecuteResponsePromiseData>,
	): void {
		this.getExecution(executionId).responsePromise = responsePromise;
	}

	resolveResponsePromise(executionId: string, response: IExecuteResponsePromiseData): void {
		const execution = this.activeExecutions[executionId];
		execution?.responsePromise?.resolve(response);
	}

	getPostExecutePromiseCount(executionId: string): number {
		return this.activeExecutions[executionId]?.postExecutePromises.length ?? 0;
	}

	/**
	 * Remove an execution after it has finished or failed
	 */
	remove(executionId: string, fullRunData?: IRun): void {
		const execution = this.activeExecutions[executionId];
		if (execution === undefined) {
			return;
		}

		this.getQueue(execution.executionData.executionMode).dequeue();

		// Resolve all the waiting promises
		for (const promise of execution.postExecutePromises) {
			promise.resolve(fullRunData);
		}

		// Remove from the list of active executions
		delete this.activeExecutions[executionId];
	}

	/**
	 * Forces an execution to stop
	 */
	async stopExecution(executionId: string): Promise<IRun | undefined> {
		const execution = this.activeExecutions[executionId];
		if (execution === undefined) {
			// There is no execution running with that id
			return;
		}

		if (execution.status === 'new') {
			await this.executionRepository.updateStatus(executionId, 'canceled');
			this.getQueue(execution.executionData.executionMode).remove(executionId);
			return;
		}

		execution.workflowExecution!.cancel();

		return await this.getPostExecutePromise(executionId);
	}

	/**
	 * Returns a promise which will resolve with the data of the execution with the given id
	 */
	async getPostExecutePromise(executionId: string): Promise<IRun | undefined> {
		// Create the promise which will be resolved when the execution finished
		const waitPromise = await createDeferredPromise<IRun | undefined>();
		this.getExecution(executionId).postExecutePromises.push(waitPromise);
		return await waitPromise.promise();
	}

	/**
	 * Returns all the currently active executions
	 */
	getActiveExecutions(): IExecutionsCurrentSummary[] {
		const returnData: IExecutionsCurrentSummary[] = [];

		let data;

		for (const id of Object.keys(this.activeExecutions)) {
			data = this.activeExecutions[id];
			returnData.push({
				id,
				retryOf: data.executionData.retryOf,
				startedAt: data.startedAt,
				mode: data.executionData.executionMode,
				workflowId: data.executionData.workflowData.id,
				status: data.status,
			});
		}

		return returnData;
	}

	getRunningExecutionIds() {
		const executions = Object.entries(this.activeExecutions);
		return executions.filter(([, value]) => value.status === 'running').map(([id]) => id);
	}

	setStatus(executionId: string, status: ExecutionStatus) {
		this.getExecution(executionId).status = status;
	}

	getStatus(executionId: string): ExecutionStatus {
		return this.getExecution(executionId).status;
	}

	/** Wait for all active executions to finish */
	async shutdown(cancelAll = false) {
		let executionIds = Object.keys(this.activeExecutions);

		if (cancelAll) {
			const stopPromises = executionIds.map(
				async (executionId) => await this.stopExecution(executionId),
			);

			await Promise.allSettled(stopPromises);
		}

		// TODO: cancel all `new` executions if they have any postExecutePromises/responsePromise

		let count = 0;
		while (executionIds.length !== 0) {
			if (count++ % 4 === 0) {
				this.logger.info(`Waiting for ${executionIds.length} active executions to finish...`);
			}

			await sleep(500);
			executionIds = Object.keys(this.activeExecutions);
		}
	}

	private getExecution(executionId: string): IExecutingWorkflowData {
		const execution = this.activeExecutions[executionId];
		if (!execution) {
			throw new ApplicationError('No active execution found', { extra: { executionId } });
		}
		return execution;
	}

	private getQueue(mode: WorkflowExecuteMode) {
		return this.queues[mode === 'manual' ? 'manual' : 'others'];
	}
}
