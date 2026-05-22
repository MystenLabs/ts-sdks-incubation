import { Box, Text, useWindowSize } from 'ink';
import type React from 'react';

import type {
	AccountProjection,
	Endpoint,
	PackageProjection,
	Row,
} from '../../substrate/projection.ts';
import {
	accountCells,
	deriveDisplayCells,
	endpointLine,
	groupRows,
	packageCells,
	visibleEndpointsForRow,
	type ColorToken,
	type DisplayRow,
	type DisplaySection,
} from './display-derivation.ts';

export interface ResourceTablesProps {
	readonly rows: ReadonlyArray<Row>;
	readonly endpoints: ReadonlyArray<Endpoint>;
	readonly accounts: ReadonlyArray<AccountProjection>;
	readonly packages: ReadonlyArray<PackageProjection>;
}

const STATE_WIDTH = 13;
const NAME_WIDTH = 18;
const MIN_URL_WIDTH = 32;
const MAX_URL_WIDTH = 96;
const DETAIL_WIDTH = 16;
const ACCOUNT_WIDTH = 14;
const ADDRESS_WIDTH = 68;
const SCHEME_WIDTH = 8;
const SOURCE_WIDTH = 8;
const FUNDING_WIDTH = 20;
const PACKAGE_WIDTH = 18;
const PACKAGE_ID_WIDTH = 68;
const MVR_WIDTH = 28;

interface PluginTableLayout {
	readonly urlWidth: number;
	readonly showDetail: boolean;
}

interface AccountTableLayout {
	readonly addressWidth: number;
	readonly showMeta: boolean;
	readonly showFunding: boolean;
	readonly showDetail: boolean;
}

interface PackageTableLayout {
	readonly packageIdWidth: number;
	readonly mvrWidth: number;
	readonly showMvr: boolean;
	readonly showDetail: boolean;
}

export const ResourceTables = ({
	rows,
	endpoints,
	accounts,
	packages,
}: ResourceTablesProps): React.JSX.Element => {
	const { columns } = useWindowSize();
	const pluginLayout = pluginTableLayout(columns);
	const accountLayout = accountTableLayout(columns);
	const packageLayout = packageTableLayout(columns);
	const sections = groupRows(rows, endpoints);
	const bySection = new Map(sections.map((section) => [section.key, section]));
	const orderedSections = [
		bySection.get('service'),
		bySection.get('package'),
		bySection.get('account'),
		bySection.get('action'),
		bySection.get('app'),
		bySection.get('other'),
	].filter((section): section is DisplaySection => section !== undefined);

	return (
		<Box flexDirection="column">
			<Text bold>Stack</Text>
			{rows.length === 0 && accounts.length === 0 && packages.length === 0 && (
				<Text>no plugins declared</Text>
			)}
			{orderedSections.map((section) =>
				section.key === 'account' ? (
					<AccountSection
						key={section.key}
						section={section}
						accounts={accounts}
						layout={accountLayout}
					/>
				) : section.key === 'package' ? (
					<PackageSection
						key={section.key}
						section={section}
						packages={packages}
						layout={packageLayout}
					/>
				) : (
					<PluginSection
						key={section.key}
						section={section}
						endpoints={endpoints}
						layout={pluginLayout}
					/>
				),
			)}
			{bySection.has('account') ? null : accounts.length > 0 ? (
				<AccountSection section={undefined} accounts={accounts} layout={accountLayout} />
			) : null}
			{bySection.has('package') ? null : packages.length > 0 ? (
				<PackageSection section={undefined} packages={packages} layout={packageLayout} />
			) : null}
		</Box>
	);
};

const PluginSection = ({
	section,
	endpoints,
	layout,
}: {
	readonly section: DisplaySection;
	readonly endpoints: ReadonlyArray<Endpoint>;
	readonly layout: PluginTableLayout;
}): React.JSX.Element => (
	<Box flexDirection="column" marginTop={1}>
		<Text bold>{section.label}</Text>
		<Header
			cells={layout.showDetail ? ['STATE', 'NAME', 'URLS', 'DETAIL'] : ['STATE', 'NAME', 'URLS']}
			widths={
				layout.showDetail
					? [STATE_WIDTH, NAME_WIDTH, layout.urlWidth, DETAIL_WIDTH]
					: [STATE_WIDTH, NAME_WIDTH, layout.urlWidth]
			}
		/>
		{section.rows.map((displayRow) => (
			<PluginRow
				key={displayRow.row.key}
				displayRow={displayRow}
				endpoints={endpoints}
				layout={layout}
			/>
		))}
	</Box>
);

const PluginRow = ({
	displayRow,
	endpoints,
	layout,
}: {
	readonly displayRow: DisplayRow;
	readonly endpoints: ReadonlyArray<Endpoint>;
	readonly layout: PluginTableLayout;
}): React.JSX.Element => {
	const cells = deriveDisplayCells(displayRow.row, endpoints);
	const urlLines = visibleEndpointsForRow(displayRow.row, endpoints).map(endpointLine);
	const detail = cells.errorSummary || cells.narration;
	const detailLines = detail.length === 0 ? [] : [`detail: ${detail}`];
	const compactUrlLines = [
		...(urlLines.length === 0 ? ['-'] : urlLines),
		...(layout.showDetail ? [] : detailLines),
	];
	return (
		<Box flexDirection="row" gap={1}>
			<StateCell glyph={cells.statusGlyph} label={cells.statusLabel} color={cells.statusColor} />
			<FixedText width={NAME_WIDTH} color={cells.labelColor} bold>
				{cells.label}
			</FixedText>
			<MultiLineFixedText
				width={layout.urlWidth}
				color={urlLines.length === 0 ? 'white' : 'cyan'}
				lines={compactUrlLines}
			/>
			{layout.showDetail && (
				<MultiLineFixedText
					width={DETAIL_WIDTH}
					color={cells.errorSummary ? 'red' : 'white'}
					lines={[detail]}
				/>
			)}
		</Box>
	);
};

const AccountSection = ({
	section,
	accounts,
	layout,
}: {
	readonly section: DisplaySection | undefined;
	readonly accounts: ReadonlyArray<AccountProjection>;
	readonly layout: AccountTableLayout;
}): React.JSX.Element => {
	const rows = section?.rows ?? [];
	const accountByRow = new Map(
		accounts
			.filter((account) => account.rowKey !== null)
			.map((account) => [account.rowKey as string, account]),
	);
	const rowKeys = new Set(rows.map(({ row }) => row.key));
	const unownedAccounts = accounts.filter(
		(account) => account.rowKey === null || !rowKeys.has(account.rowKey),
	);

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text bold>Accounts</Text>
			<Header
				cells={[
					'STATE',
					'ACCOUNT',
					'ADDRESS',
					...(layout.showMeta ? ['SCHEME', 'SOURCE'] : []),
					...(layout.showFunding ? ['FUNDING'] : []),
					...(layout.showDetail ? ['DETAIL'] : []),
				]}
				widths={[
					STATE_WIDTH,
					ACCOUNT_WIDTH,
					layout.addressWidth,
					...(layout.showMeta ? [SCHEME_WIDTH, SOURCE_WIDTH] : []),
					...(layout.showFunding ? [FUNDING_WIDTH] : []),
					...(layout.showDetail ? [DETAIL_WIDTH] : []),
				]}
			/>
			{rows.map((displayRow) => (
				<AccountRow
					key={displayRow.row.key}
					displayRow={displayRow}
					account={accountByRow.get(displayRow.row.key)}
					layout={layout}
				/>
			))}
			{unownedAccounts.map((account) => (
				<AccountRecordRow key={account.key} account={account} layout={layout} />
			))}
		</Box>
	);
};

const PackageSection = ({
	section,
	packages,
	layout,
}: {
	readonly section: DisplaySection | undefined;
	readonly packages: ReadonlyArray<PackageProjection>;
	readonly layout: PackageTableLayout;
}): React.JSX.Element => {
	const rows = section?.rows ?? [];
	const packageByRow = new Map(
		packages.filter((pkg) => pkg.rowKey !== null).map((pkg) => [pkg.rowKey as string, pkg]),
	);
	const rowKeys = new Set(rows.map(({ row }) => row.key));
	const unownedPackages = packages.filter((pkg) => pkg.rowKey === null || !rowKeys.has(pkg.rowKey));

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text bold>Packages</Text>
			<Header
				cells={[
					'STATE',
					'PACKAGE',
					'PACKAGE ID',
					...(layout.showMvr ? ['MVR'] : []),
					...(layout.showDetail ? ['DETAIL'] : []),
				]}
				widths={[
					STATE_WIDTH,
					PACKAGE_WIDTH,
					layout.packageIdWidth,
					...(layout.showMvr ? [layout.mvrWidth] : []),
					...(layout.showDetail ? [DETAIL_WIDTH] : []),
				]}
			/>
			{rows.map((displayRow) => (
				<PackageRow
					key={displayRow.row.key}
					displayRow={displayRow}
					pkg={packageByRow.get(displayRow.row.key)}
					layout={layout}
				/>
			))}
			{unownedPackages.map((pkg) => (
				<PackageRecordRow key={pkg.key} pkg={pkg} layout={layout} />
			))}
		</Box>
	);
};

const AccountRow = ({
	displayRow,
	account,
	layout,
}: {
	readonly displayRow: DisplayRow;
	readonly account: AccountProjection | undefined;
	readonly layout: AccountTableLayout;
}): React.JSX.Element => {
	const cells = deriveDisplayCells(displayRow.row);
	const facts =
		account === undefined
			? {
					name: cells.label,
					address: '<pending>',
					scheme: 'pending',
					source: 'pending',
					funding: 'funding pending',
				}
			: accountCells(account);
	const detail = cells.errorSummary || cells.narration || '-';

	return (
		<Box flexDirection="row" gap={1}>
			<StateCell glyph={cells.statusGlyph} label={cells.statusLabel} color={cells.statusColor} />
			<FixedText width={ACCOUNT_WIDTH} color={cells.labelColor} bold>
				{facts.name}
			</FixedText>
			<MultiLineFixedText width={layout.addressWidth} color="white" lines={[facts.address]} />
			{layout.showMeta && (
				<>
					<FixedText width={SCHEME_WIDTH} color="white">
						{facts.scheme}
					</FixedText>
					<FixedText width={SOURCE_WIDTH} color="white">
						{facts.source}
					</FixedText>
				</>
			)}
			{layout.showFunding && (
				<FixedText width={FUNDING_WIDTH} color="white">
					{facts.funding}
				</FixedText>
			)}
			{layout.showDetail && (
				<MultiLineFixedText
					width={DETAIL_WIDTH}
					color={cells.errorSummary ? 'red' : 'white'}
					lines={[detail]}
				/>
			)}
		</Box>
	);
};

const PackageRow = ({
	displayRow,
	pkg,
	layout,
}: {
	readonly displayRow: DisplayRow;
	readonly pkg: PackageProjection | undefined;
	readonly layout: PackageTableLayout;
}): React.JSX.Element => {
	const cells = deriveDisplayCells(displayRow.row);
	const facts =
		pkg === undefined
			? {
					name: cells.label,
					packageId: '<pending>',
					mvr: 'pending',
					detail: cells.errorSummary || cells.narration || 'publish pending',
				}
			: packageCells(pkg);
	const detail = cells.errorSummary || cells.narration || facts.detail || '-';

	return (
		<Box flexDirection="row" gap={1}>
			<StateCell glyph={cells.statusGlyph} label={cells.statusLabel} color={cells.statusColor} />
			<FixedText width={PACKAGE_WIDTH} color={cells.labelColor} bold>
				{facts.name}
			</FixedText>
			<MultiLineFixedText width={layout.packageIdWidth} color="white" lines={[facts.packageId]} />
			{layout.showMvr && (
				<MultiLineFixedText width={layout.mvrWidth} color="white" lines={[facts.mvr]} />
			)}
			{layout.showDetail && (
				<MultiLineFixedText
					width={DETAIL_WIDTH}
					color={cells.errorSummary ? 'red' : 'white'}
					lines={[detail]}
				/>
			)}
		</Box>
	);
};

const AccountRecordRow = ({
	account,
	layout,
}: {
	readonly account: AccountProjection;
	readonly layout: AccountTableLayout;
}): React.JSX.Element => {
	const facts = accountCells(account);
	return (
		<Box flexDirection="row" gap={1}>
			<FixedText width={STATE_WIDTH} color="white">
				record
			</FixedText>
			<FixedText width={ACCOUNT_WIDTH} color="magenta" bold>
				{facts.name}
			</FixedText>
			<MultiLineFixedText width={layout.addressWidth} color="white" lines={[facts.address]} />
			{layout.showMeta && (
				<>
					<FixedText width={SCHEME_WIDTH} color="white">
						{facts.scheme}
					</FixedText>
					<FixedText width={SOURCE_WIDTH} color="white">
						{facts.source}
					</FixedText>
				</>
			)}
			{layout.showFunding && (
				<FixedText width={FUNDING_WIDTH} color="white">
					{facts.funding}
				</FixedText>
			)}
			{layout.showDetail && (
				<FixedText width={DETAIL_WIDTH} color="white">
					-
				</FixedText>
			)}
		</Box>
	);
};

const PackageRecordRow = ({
	pkg,
	layout,
}: {
	readonly pkg: PackageProjection;
	readonly layout: PackageTableLayout;
}): React.JSX.Element => {
	const facts = packageCells(pkg);
	return (
		<Box flexDirection="row" gap={1}>
			<FixedText width={STATE_WIDTH} color="white">
				record
			</FixedText>
			<FixedText width={PACKAGE_WIDTH} color="magenta" bold>
				{facts.name}
			</FixedText>
			<MultiLineFixedText width={layout.packageIdWidth} color="white" lines={[facts.packageId]} />
			{layout.showMvr && (
				<MultiLineFixedText width={layout.mvrWidth} color="white" lines={[facts.mvr]} />
			)}
			{layout.showDetail && (
				<MultiLineFixedText width={DETAIL_WIDTH} color="white" lines={[facts.detail]} />
			)}
		</Box>
	);
};

const StateCell = ({
	glyph,
	label,
	color,
}: {
	readonly glyph: string;
	readonly label: string;
	readonly color: ColorToken;
}): React.JSX.Element => (
	<FixedText width={STATE_WIDTH} color={color}>
		{`${glyph} ${label}`}
	</FixedText>
);

const Header = ({
	cells,
	widths,
}: {
	readonly cells: ReadonlyArray<string>;
	readonly widths: ReadonlyArray<number>;
}): React.JSX.Element => (
	<Box flexDirection="row" gap={1}>
		{cells.map((cell, index) =>
			widths[index] === 0 ? (
				<Text key={`${index}:${cell}`} bold>
					{cell}
				</Text>
			) : (
				<FixedText key={`${index}:${cell}`} width={widths[index] ?? 0} color="white" bold>
					{cell}
				</FixedText>
			),
		)}
	</Box>
);

const FixedText = ({
	width,
	color,
	bold = false,
	children,
}: {
	readonly width: number;
	readonly color: ColorToken;
	readonly bold?: boolean;
	readonly children: string;
}): React.JSX.Element => (
	<Box width={width} flexShrink={0}>
		<Text color={color} bold={bold}>
			{clip(children, width)}
		</Text>
	</Box>
);

const MultiLineFixedText = ({
	width,
	color,
	lines,
}: {
	readonly width: number;
	readonly color: ColorToken;
	readonly lines: ReadonlyArray<string>;
}): React.JSX.Element => (
	<Box width={width} flexShrink={0} flexDirection="column">
		{lines
			.flatMap((line) => wrap(line, width))
			.map((line, index) => (
				<Text key={`${index}:${line}`} color={color} wrap="truncate-end">
					{line}
				</Text>
			))}
	</Box>
);

const clip = (value: string, width: number): string => {
	if (width <= 0 || value.length <= width) return value;
	if (width <= 1) return value.slice(0, width);
	return `${value.slice(0, width - 1)}…`;
};

const pluginTableLayout = (columns: number): PluginTableLayout => {
	const gapCount = (showDetail: boolean): number => (showDetail ? 3 : 2);
	const detailBudget = STATE_WIDTH + NAME_WIDTH + DETAIL_WIDTH + MIN_URL_WIDTH + gapCount(true);
	const showDetail = columns >= detailBudget;
	const fixedWidth =
		STATE_WIDTH + NAME_WIDTH + (showDetail ? DETAIL_WIDTH : 0) + gapCount(showDetail);
	const availableUrlWidth = Math.max(MIN_URL_WIDTH, columns - fixedWidth);
	return {
		showDetail,
		urlWidth: Math.min(MAX_URL_WIDTH, availableUrlWidth),
	};
};

const accountTableLayout = (columns: number): AccountTableLayout => {
	const fullWidth =
		STATE_WIDTH +
		ACCOUNT_WIDTH +
		ADDRESS_WIDTH +
		SCHEME_WIDTH +
		SOURCE_WIDTH +
		FUNDING_WIDTH +
		DETAIL_WIDTH +
		6;
	const midWidth =
		STATE_WIDTH + ACCOUNT_WIDTH + 32 + SCHEME_WIDTH + SOURCE_WIDTH + FUNDING_WIDTH + 5;
	const showDetail = columns >= fullWidth;
	const showMeta = columns >= midWidth;
	const showFunding = columns >= midWidth;
	const fixed =
		STATE_WIDTH +
		ACCOUNT_WIDTH +
		(showMeta ? SCHEME_WIDTH + SOURCE_WIDTH : 0) +
		(showFunding ? FUNDING_WIDTH : 0) +
		(showDetail ? DETAIL_WIDTH : 0) +
		(1 + (showMeta ? 2 : 0) + (showFunding ? 1 : 0) + (showDetail ? 1 : 0));
	return {
		showDetail,
		showMeta,
		showFunding,
		addressWidth: Math.min(ADDRESS_WIDTH, Math.max(24, columns - fixed)),
	};
};

const packageTableLayout = (columns: number): PackageTableLayout => {
	const fullWidth = STATE_WIDTH + PACKAGE_WIDTH + PACKAGE_ID_WIDTH + MVR_WIDTH + DETAIL_WIDTH + 4;
	const showDetail = columns >= fullWidth;
	const showMvr = columns >= STATE_WIDTH + PACKAGE_WIDTH + 24 + 16 + 3;
	const fixed =
		STATE_WIDTH +
		PACKAGE_WIDTH +
		(showMvr ? MVR_WIDTH : 0) +
		(showDetail ? DETAIL_WIDTH : 0) +
		(1 + (showMvr ? 1 : 0) + (showDetail ? 1 : 0));
	return {
		showDetail,
		showMvr,
		mvrWidth: showDetail ? MVR_WIDTH : 20,
		packageIdWidth: Math.min(PACKAGE_ID_WIDTH, Math.max(24, columns - fixed)),
	};
};

const wrap = (value: string, width: number): ReadonlyArray<string> => {
	const limit = Math.max(1, width - 1);
	if (width <= 0 || value.length <= limit) return [value];
	const lines: Array<string> = [];
	let rest = value;
	while (rest.length > limit) {
		const idx = wrapIndex(rest, limit);
		lines.push(rest.slice(0, idx).trimEnd());
		rest = rest.slice(idx).trimStart();
	}
	if (rest.length > 0) lines.push(rest);
	return lines;
};

const wrapIndex = (value: string, width: number): number => {
	const window = value.slice(0, width + 1);
	const candidates = [' -> ', ' | ', ' '];
	let bestIndex = -1;
	let bestLength = 0;
	for (const candidate of candidates) {
		const idx = window.lastIndexOf(candidate);
		if (idx > bestIndex) {
			bestIndex = idx;
			bestLength = candidate.length;
		}
	}
	if (bestIndex > 0) return bestIndex + bestLength;
	return width;
};
