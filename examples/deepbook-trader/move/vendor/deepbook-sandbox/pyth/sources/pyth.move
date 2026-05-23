// MOCK PYTH CONTRACT FOR LOCALNET
module pyth::pyth {
    use sui::clock::{Self, Clock};

    use pyth::price_info::{Self, PriceInfo, PriceInfoObject};
    use pyth::price_feed::{Self};
    use pyth::price::{Self, Price};

    const E_STALE_PRICE_UPDATE: u64 = 1;

    /// MOCK IMPLEMENTATION
    /// Create and share new price feed objects
    public fun create_price_feeds(
        mut price_infos: vector<PriceInfo>,
        ctx: &mut TxContext
    ){
        while (!vector::is_empty(&price_infos)) {
            let cur_price_info = vector::pop_back(&mut price_infos);
            let new_price_info_object = price_info::new_price_info_object(cur_price_info, ctx);
            transfer::public_share_object(new_price_info_object);
        };
    }

    /// MOCK IMPLEMENTATION
    /// Update a singular Pyth PriceInfoObject (containing a price feed)
    public fun update_single_price_feed(
        update: &PriceInfo,
        price_info_object: &mut PriceInfoObject,
    ) {
        if (is_fresh_update(update, price_info_object)){
            price_info::update_price_info_object(
                price_info_object,
                update
            );
        }
    }

    /// Determine if the given price update is "fresh": we have nothing newer already cached for that
    /// price feed within a PriceInfoObject.
    fun is_fresh_update(update: &PriceInfo, price_info_object: &PriceInfoObject): bool {
        // Get the timestamp of the update's current price
        let price_feed = price_info::get_price_feed(update);
        let update_timestamp = price::get_timestamp(&price_feed::get_price(price_feed));

        // Get the timestamp of the cached data for the price identifier
        let cached_price_info = price_info::get_price_info_from_price_info_object(price_info_object);
        let cached_price_feed =  price_info::get_price_feed(&cached_price_info);
        let cached_timestamp = price::get_timestamp(&price_feed::get_price(cached_price_feed));

        update_timestamp > cached_timestamp
    }

    /// Get the latest available price cached for the given price identifier, if that price is
    /// no older than the given age.
    public fun get_price_no_older_than(price_info_object: &PriceInfoObject, clock: &Clock, max_age_secs: u64): Price {
        let price = get_price_unsafe(price_info_object);
        check_price_is_fresh(&price, clock, max_age_secs);
        price
    }

    /// MOCK IMPLEMENTATION
    /// Get the latest available price cached for the given price identifier.
    ///
    /// WARNING: the returned price can be from arbitrarily far in the past.
    /// This function makes no guarantees that the returned price is recent or
    /// useful for any particular application. Users of this function should check
    /// the returned timestamp to ensure that the returned price is sufficiently
    /// recent for their application. The checked get_price_no_older_than()
    /// function should be used in preference to this.
    public fun get_price_unsafe(price_info_object: &PriceInfoObject): Price {
        // TODO: extract Price from this guy...
        let price_info = price_info::get_price_info_from_price_info_object(price_info_object);
        price_feed::get_price(
            price_info::get_price_feed(&price_info)
        )
    }

    fun abs_diff(x: u64, y: u64): u64 {
        if (x > y) {
            return x - y
        } else {
            return y - x
        }
    }

    fun check_price_is_fresh(price: &Price, clock: &Clock, max_age_secs: u64) {
        let age = abs_diff(clock::timestamp_ms(clock)/1000, price::get_timestamp(price));
        assert!(age < max_age_secs, E_STALE_PRICE_UPDATE);
    }
}
