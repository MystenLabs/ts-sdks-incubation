export const normalizeSuiAddress = (address: string): string | null => {
	if (!address.startsWith('0x')) return null;
	const hex = address.slice(2).toLowerCase();
	if (!/^[0-9a-f]+$/.test(hex)) return null;
	return `0x${hex.replace(/^0+/, '') || '0'}`;
};

export const normalizeStructTypeAddress = (typeName: string): string | null => {
	const parts = typeName.split('::');
	if (parts.length !== 3) return null;
	const [address, moduleName, structName] = parts;
	if (address === undefined || moduleName === undefined || structName === undefined) return null;
	const normalizedAddress =
		normalizeSuiAddress(address) ?? (address.startsWith('0x') ? address : null);
	if (normalizedAddress === null) return null;
	return `${normalizedAddress}::${moduleName}::${structName}`;
};

/** Parse the inner generic out of Sui-framework `coin::<Wrapper><INNER>`.
 *  The SDK may spell the framework address as `0x2` or fully padded
 *  `0x000...0002`; normalize before matching. Returns `null` if the
 *  inner generic itself carries angle brackets. */
export const pickSuiFrameworkInnerGeneric = (
	objectType: string,
	wrapperName: string,
): string | null => {
	if (!objectType.endsWith('>')) return null;
	const firstSep = objectType.indexOf('::');
	const secondSep = objectType.indexOf('::', firstSep + 2);
	if (firstSep === -1 || secondSep === -1) return null;
	const address = objectType.slice(0, firstSep);
	const moduleName = objectType.slice(firstSep + 2, secondSep);
	const rest = objectType.slice(secondSep + 2);
	if (normalizeSuiAddress(address) !== '0x2') return null;
	if (moduleName !== 'coin') return null;
	const wrapperPrefix = `${wrapperName}<`;
	if (!rest.startsWith(wrapperPrefix)) return null;
	const inner = rest.slice(wrapperPrefix.length, -1);
	if (inner.includes('<') || inner.includes('>')) return null;
	if (normalizeStructTypeAddress(inner) === null) return null;
	return inner;
};

export const isSuiFrameworkObjectForCoin = (
	objectType: string,
	wrapperName: string,
	fullCoinType: string,
): boolean => {
	const inner = pickSuiFrameworkInnerGeneric(objectType, wrapperName);
	if (inner === null) return false;
	const normalizedInner = normalizeStructTypeAddress(inner);
	const normalizedExpected = normalizeStructTypeAddress(fullCoinType);
	return (
		normalizedInner !== null &&
		normalizedExpected !== null &&
		normalizedInner === normalizedExpected
	);
};
