// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SuiClientTypes } from '@mysten/sui/client';
import { parse, safeParse } from 'valibot';
import type { AutoApprovalState } from './schemas/state.js';
import { AutoApprovalStateSchema } from './schemas/state.js';
import type { AutoApprovalSettings } from './schemas/policy.js';
import { AutoApprovalPolicySchema, AutoApprovalSettingsSchema } from './schemas/policy.js';
import { normalizeSuiAddress, parseStructTag } from '@mysten/sui/utils';
import type { AutoApprovalResult } from './analyzer.js';
import type { CoinFlow } from '@mysten/wallet-sdk';

type SuccessfulAutoApprovalResult = Extract<AutoApprovalResult, { status: 'success' }>;

export interface AutoApprovalManagerOptions {
	policy: string;
	state: string | null;
}

export interface AutoApprovalIssue {
	message: string;
}

export interface AutoApprovalCheck {
	matchesPolicy: boolean;
	canAutoApprove: boolean;
	policyIssues: AutoApprovalIssue[];
	settingsIssues: AutoApprovalIssue[];
	analysisIssues: AutoApprovalIssue[];
}

export class AutoApprovalManager {
	#state: AutoApprovalState;

	constructor(options: AutoApprovalManagerOptions) {
		const policy = parse(AutoApprovalPolicySchema, JSON.parse(options.policy));
		let state: AutoApprovalState | null = null;

		if (options.state) {
			let savedState: AutoApprovalState | null = null;

			try {
				const parseResult = safeParse(AutoApprovalStateSchema, JSON.parse(options.state));
				if (parseResult.success) {
					savedState = parseResult.output;
				} else {
					console.warn(
						'[auto-approvals] Ignoring saved state that does not match the state schema.',
						parseResult.issues,
					);
				}
			} catch (error) {
				console.warn('[auto-approvals] Ignoring saved state that could not be decoded.', error);
			}

			if (savedState && JSON.stringify(savedState.policy) === JSON.stringify(policy)) {
				state = savedState;
			}
		}

		this.#state =
			state ??
			parse(AutoApprovalStateSchema, {
				schemaVersion: '1.0.0',
				policy,
				settings: null,
				pendingDigests: [],
			} satisfies AutoApprovalState);
	}

	checkTransaction(analysis: AutoApprovalResult): AutoApprovalCheck {
		const results: AutoApprovalCheck = {
			matchesPolicy: false,
			canAutoApprove: false,
			analysisIssues:
				analysis.status === 'success'
					? []
					: analysis.issues.length
						? [...analysis.issues]
						: [{ message: 'Transaction analysis failed' }],
			policyIssues: [],
			settingsIssues: [],
		};

		if (results.analysisIssues.length > 0) {
			return results;
		}

		const policyIssues = this.#matchesPolicy(analysis);

		if (policyIssues.length > 0) {
			results.policyIssues = policyIssues;
			return results;
		} else {
			results.matchesPolicy = true;
		}

		const settingsIssues = this.#canAutoApprove(analysis);

		if (settingsIssues.length > 0) {
			results.settingsIssues = settingsIssues;
			return results;
		} else {
			results.canAutoApprove = true;
		}

		return results;
	}

	#matchesPolicy(analysis: AutoApprovalResult): AutoApprovalIssue[] {
		const issues: AutoApprovalIssue[] = [];

		if (analysis.status !== 'success') {
			issues.push({ message: 'Transaction analysis failed' });
			return issues;
		}

		if (!analysis.result.operationType) {
			issues.push({ message: 'Operation type not found in Transaction' });

			return issues;
		}

		const operation = this.#state.policy.operations.find(
			(op) => op.id === analysis.result.operationType,
		);

		if (!operation) {
			issues.push({ message: 'Operation not found in policy' });
			return issues;
		}

		if (!operation.permissions.anyBalance) {
			for (const outflow of getSenderOutflows(analysis)) {
				if (!operation.permissions.balances?.find((b) => b.coinType === outflow.coinType)) {
					issues.push({
						message: `Operation does not have permission to use coin type ${outflow.coinType}`,
					});
				}
			}
		}

		for (const obj of analysis.result.ownedObjects) {
			if (isCoinType(obj.type)) {
				continue;
			}

			const accessLevel = analysis.result.accessLevel[obj.objectId];

			if (!accessLevel) {
				issues.push({ message: `Access level could not be determined for object ${obj.objectId}` });
				continue;
			}

			const ownedObjectsPermission = operation.permissions.ownedObjects?.find(
				(p) => p.objectType === obj.type,
			);

			if (!ownedObjectsPermission) {
				issues.push({ message: `No permission found for object ${obj.objectId}` });
			} else if (!hasSufficientAccess(ownedObjectsPermission.accessLevel, accessLevel)) {
				issues.push({
					message: `Insufficient access level for object ${obj.objectId}: required ${accessLevel}, got ${ownedObjectsPermission.accessLevel}`,
				});
			}
		}

		return issues;
	}

	#canAutoApprove(analysis: AutoApprovalResult): AutoApprovalIssue[] {
		const issues: AutoApprovalIssue[] = [];

		if (!this.#state.settings) {
			issues.push({ message: 'No auto-approval settings configured' });
			return issues;
		}

		if (analysis.status !== 'success') {
			issues.push({ message: 'Transaction analysis failed' });
			return issues;
		}

		if (this.#state.pendingDigests.includes(analysis.result.digest)) {
			issues.push({ message: `Transaction ${analysis.result.digest} is already pending` });
		}

		if (new Date() > new Date(this.#state.settings.expiration)) {
			issues.push({ message: 'Auto-approval settings have expired' });
		}

		if (
			this.#state.settings.remainingTransactions !== null &&
			this.#state.settings.remainingTransactions <= 0
		) {
			issues.push({ message: 'No remaining auto-approved transactions' });
		}

		if (
			!analysis.result.operationType ||
			!this.#state.settings.approvedOperations.includes(analysis.result.operationType)
		) {
			issues.push({ message: 'Operation type not approved for auto-approval' });
		}

		let usesSharedBudget = false;
		let sharedBudgetSpend = 0;

		for (const outflow of getSenderOutflows(analysis)) {
			const coinBudget = this.#state.settings.coinBudgets[outflow.coinType];

			if (coinBudget !== undefined) {
				if (BigInt(coinBudget) < outflow.amount) {
					issues.push({
						message: `Insufficient budget for coin type ${outflow.coinType}`,
					});
				}
				continue;
			}

			const coinAmount = analysis.result.coinValues.coinTypes.find(
				(ct) => ct.coinType === outflow.coinType,
			);

			if (!coinAmount) {
				issues.push({
					message: `No budget configured for coin type ${outflow.coinType}`,
				});
				continue;
			}

			usesSharedBudget = true;
			sharedBudgetSpend += coinAmount.convertedAmount;
		}

		if (usesSharedBudget) {
			if (this.#state.settings.sharedBudget === null) {
				issues.push({ message: 'No shared budget configured' });
			} else if (this.#state.settings.sharedBudget < sharedBudgetSpend) {
				issues.push({ message: 'Insufficient shared budget' });
			}
		}

		return issues;
	}

	commitTransaction(analysis: AutoApprovalResult): void {
		assertSuccessfulAnalysis(analysis);

		const check = this.checkTransaction(analysis);
		if (!check.canAutoApprove) {
			const [issue] = [...check.policyIssues, ...check.settingsIssues];
			throw new Error(`Transaction cannot be auto-approved: ${issue?.message}`);
		}

		if (!this.#state.settings) {
			throw new Error('No auto-approval settings configured');
		}

		if (this.#state.settings.remainingTransactions !== null && this.#state.settings) {
			this.#state.settings.remainingTransactions = Math.max(
				0,
				this.#state.settings.remainingTransactions - 1,
			);
		}

		for (const outflow of getSenderOutflows(analysis)) {
			if (this.#state.settings.coinBudgets[outflow.coinType] !== undefined) {
				const currentBudget = BigInt(this.#state.settings?.coinBudgets[outflow.coinType] ?? '0');
				const newBalance = currentBudget - outflow.amount;
				this.#state.settings.coinBudgets[outflow.coinType] = newBalance.toString();
			} else {
				if (this.#state.settings.sharedBudget === null) {
					throw new Error('No budget available for coin type ' + outflow.coinType);
				}

				const coinValue = analysis.result.coinValues.coinTypes.find(
					(ct) => ct.coinType === outflow.coinType,
				);

				if (!coinValue) {
					throw new Error('No value available for coin type ' + outflow.coinType);
				}

				this.#state.settings.sharedBudget -= coinValue.convertedAmount;
			}
		}

		this.#state.pendingDigests.push(analysis.result.digest);
	}

	revertTransaction(analysis: AutoApprovalResult): void {
		assertSuccessfulAnalysis(analysis);

		if (analysis.result?.digest) {
			this.#removePendingDigest(analysis.result?.digest);
		}

		if (this.#state.settings?.remainingTransactions !== null && this.#state.settings) {
			this.#state.settings.remainingTransactions += 1;
		}

		this.#revertBalanceFlows(analysis);
	}

	#revertBalanceFlows(analysis: AutoApprovalResult): void {
		assertSuccessfulAnalysis(analysis);

		if (!this.#state.settings) {
			throw new Error('No auto-approval settings configured');
		}

		for (const outflow of getSenderOutflows(analysis)) {
			if (this.#state.settings?.coinBudgets[outflow.coinType] !== undefined) {
				const currentBudget = BigInt(this.#state.settings?.coinBudgets[outflow.coinType] ?? '0');
				const newBalance = currentBudget + outflow.amount;
				this.#state.settings.coinBudgets[outflow.coinType] = newBalance.toString();
			} else {
				if (this.#state.settings.sharedBudget === null) {
					throw new Error('No budget available for coin type ' + outflow.coinType);
				}

				const coinValue = analysis.result.coinValues.coinTypes.find(
					(ct) => ct.coinType === outflow.coinType,
				);

				if (!coinValue) {
					throw new Error('No value available for coin type ' + outflow.coinType);
				}

				this.#state.settings.sharedBudget += coinValue.convertedAmount;
			}
		}
	}

	#removePendingDigest(digest: string): void {
		const pendingIndex = this.#state.pendingDigests.indexOf(digest);
		if (pendingIndex >= 0) {
			this.#state.pendingDigests.splice(pendingIndex, 1);
		} else {
			throw new Error(`Transaction with digest ${digest} not found in pending digests`);
		}
	}

	applyTransactionEffects(
		analysis: AutoApprovalResult,
		result: SuiClientTypes.Transaction<{ balanceChanges: true }>,
	): void {
		assertSuccessfulAnalysis(analysis);

		if (result.digest !== analysis.result.digest) {
			throw new Error(
				`Transaction digest ${result.digest} does not match analyzed digest ${analysis.result.digest}`,
			);
		}

		this.#removePendingDigest(result.digest);

		if (!this.#state.settings) {
			throw new Error('No auto-approval settings configured');
		}

		// Revert provisional balance flows and use real sender balance changes instead.
		this.#revertBalanceFlows(analysis);

		const outflowCoinTypes = new Set(getSenderOutflows(analysis).map((flow) => flow.coinType));

		for (const change of result.balanceChanges) {
			if (
				!analysis.result.senderAddresses.includes(normalizeSuiAddress(change.address)) ||
				!outflowCoinTypes.has(change.coinType)
			) {
				continue;
			}

			if (this.#state.settings.coinBudgets[change.coinType] !== undefined) {
				const currentBudget = BigInt(this.#state.settings?.coinBudgets[change.coinType] ?? '0');
				const newBalance = currentBudget + BigInt(change.amount);
				if (this.#state.settings) {
					this.#state.settings.coinBudgets[change.coinType] = newBalance.toString();
				}
			} else {
				if (this.#state.settings.sharedBudget === null) {
					throw new Error('No budget available for coin type ' + change.coinType);
				}

				const coinValue = analysis.result.coinValues.coinTypes.find(
					(ct) => ct.coinType === change.coinType,
				);

				if (!coinValue) {
					throw new Error('No value available for coin type ' + change.coinType);
				}

				const convertedChange =
					(Number(change.amount) / 10 ** coinValue.decimals) * coinValue.price;

				this.#state.settings.sharedBudget += convertedChange;
			}
		}
	}

	reset() {
		this.#state = {
			schemaVersion: '1.0.0',
			policy: this.#state.policy,
			settings: null,
			pendingDigests: [],
		};
	}

	export(): string {
		return JSON.stringify(parse(AutoApprovalStateSchema, this.#state));
	}

	getState(): AutoApprovalState {
		return parse(AutoApprovalStateSchema, this.#state);
	}

	getSettings(): AutoApprovalSettings | null {
		return structuredClone(this.#state.settings);
	}

	updateSettings(settings: AutoApprovalSettings): void {
		if (this.#state.pendingDigests.length > 0) {
			throw new Error('Settle or revert pending transactions before updating settings');
		}

		const validatedSettings = parse(AutoApprovalSettingsSchema, settings);
		this.#state.settings = validatedSettings;
	}
}

function getSenderOutflows(analysis: SuccessfulAutoApprovalResult): CoinFlow[] {
	return analysis.result.senderBalanceFlows
		.filter((flow) => flow.amount < 0n)
		.map((flow) => ({
			coinType: flow.coinType,
			amount: -flow.amount,
		}));
}

const parsedCoinType = parseStructTag('0x2::coin::Coin');

function isCoinType(type: string): boolean {
	const parsedType = parseStructTag(type);
	return (
		parsedType.address === parsedCoinType.address &&
		parsedType.module === parsedCoinType.module &&
		parsedType.name === parsedCoinType.name &&
		parsedType.typeParams.length === 1
	);
}

function assertSuccessfulAnalysis(
	analysis: AutoApprovalResult,
): asserts analysis is SuccessfulAutoApprovalResult {
	if (analysis.status !== 'success') {
		throw new Error('Transaction analysis failed');
	}
}

const ACCESS_LEVEL_RANK = { read: 0, mutate: 1, transfer: 2 } as const;

function hasSufficientAccess(
	granted: keyof typeof ACCESS_LEVEL_RANK,
	needed: keyof typeof ACCESS_LEVEL_RANK,
): boolean {
	return ACCESS_LEVEL_RANK[granted] >= ACCESS_LEVEL_RANK[needed];
}
