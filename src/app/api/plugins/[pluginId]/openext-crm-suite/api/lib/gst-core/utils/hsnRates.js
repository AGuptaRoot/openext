/*
 * Curated HSN / SAC → usual GST rate lookup (a hint, never a lock).
 *
 * Not the full CBIC schedule — a hand-picked subset of the codes small
 * businesses invoice most. InvoiceGenerator shows the match under the HSN
 * box and auto-fills the line's GST % from it (see autoFillRate).
 *
 * RATES CHECKED 29 Oct 2026 against the structure in force since
 * 22 Sep 2025 (5% / 18% / 40%; 12% and 28% gone for these goods):
 *   - GST Council 56th meeting press release (PIB, 3 Sep 2025), Annexures
 *     I-IV: https://gstcouncil.gov.in/sites/default/files/2025-09/press_release_press_information_bureau.pdf
 *   - Notification 9/2025-Integrated Tax (Rate), 17 Sep 2025 (Schedule I 5%,
 *     II 18%, III 40%); same entries as 9/2025-Central Tax (Rate)
 *   - Long-standing exemptions (fresh milk, vegetables, loose cereals and
 *     pulses, printed books, health care) per Notifications 2/2017 and
 *     12/2017-Central Tax (Rate), unchanged by the 56th meeting.
 * Codes whose rate could not be checked were removed rather than guessed.
 *
 * Entry shapes:
 *   { rate: 5, label }          one usual rate → may be auto-filled.
 *   { rates: [5, 18], label }   rate depends on price / size / packing →
 *                               shown as a hint, NEVER auto-filled.
 *
 * Lookup: the longest key (8 → 4 digits) that the typed code starts with.
 */

export const HSN_RATES = {
  // ─── Food & grocery ─────────────────────────────────────────────
  '0401': { rate: 0,  label: 'Milk (fresh, pasteurised, UHT)' },
  '0701': { rate: 0,  label: 'Potatoes, fresh' },
  '0702': { rate: 0,  label: 'Tomatoes, fresh' },
  '0713': { rates: [0, 5],  label: 'Dried pulses / dal: loose 0%, pre-packaged and labelled 5%' },
  '0801': { rates: [0, 5],  label: 'Coconuts, cashew, brazil nuts: fresh coconut 0%, cashew / dried 5%' },
  '0802': { rate: 5,  label: 'Almonds, walnuts, pistachios and other dried nuts' },
  '0901': { rates: [0, 5],  label: 'Coffee: roasted 5%, raw beans (not roasted) 0%' },
  '0902': { rate: 5,  label: 'Tea, processed' },
  '1006': { rates: [0, 5],  label: 'Rice: loose 0%, pre-packaged and labelled 5%' },
  '1101': { rates: [0, 5],  label: 'Wheat flour / atta: loose 0%, pre-packaged and labelled 5%' },
  '1701': { rate: 5,  label: 'Cane / beet sugar' },
  '1704': { rate: 5,  label: 'Sugar confectionery, sweets, toffees (no cocoa)' },
  '1806': { rate: 5,  label: 'Chocolate & cocoa products' },
  '1905': { rates: [0, 5],  label: 'Bakery: biscuits, cakes, pastries 5%; bread, pizza bread, roti, khakhra 0%' },
  '190531': { rate: 5, label: 'Sweet biscuits' },
  '2201': { rate: 5,  label: 'Packaged / mineral water, soda (no sugar or flavour)' },
  '2202': { rates: [5, 40], label: 'Drinks: soft / sweetened / caffeinated 40%; fruit-juice, milk, soya drinks 5%' },
  '220210': { rate: 40, label: 'Soft drinks, aerated / sweetened or flavoured waters' },

  // ─── Textiles & apparel ────────────────────────────────────────
  '5205': { rate: 5,  label: 'Cotton yarn' },
  '5208': { rate: 5,  label: 'Cotton fabric' },
  '6109': { rates: [5, 18], label: 'T-shirts, vests: up to ₹2,500 a piece 5%, above 18%' },
  '6110': { rates: [5, 18], label: 'Sweaters, pullovers: up to ₹2,500 a piece 5%, above 18%' },
  '6203': { rates: [5, 18], label: "Men's suits, jackets, trousers: up to ₹2,500 a piece 5%, above 18%" },
  '6204': { rates: [5, 18], label: "Women's suits, dresses: up to ₹2,500 a piece 5%, above 18%" },
  '6205': { rates: [5, 18], label: "Men's shirts: up to ₹2,500 a piece 5%, above 18%" },
  '6206': { rates: [5, 18], label: "Women's blouses, shirts: up to ₹2,500 a piece 5%, above 18%" },
  '6403': { rates: [5, 18], label: 'Leather footwear: up to ₹2,500 a pair 5%, above 18%' },

  // ─── Paper, books, stationery ──────────────────────────────────
  '4801': { rate: 5,  label: 'Newsprint' },
  '4802': { rates: [0, 5, 18], label: 'Uncoated paper: for exercise books 0%, hand-made 5%, writing / printing 18%' },
  '4820': { rates: [0, 18], label: 'Exercise / note books 0%; registers, diaries, letter pads 18%' },
  '4901': { rates: [0, 5],  label: 'Printed books 0%; brochures, leaflets 5%' },
  '4907': { rate: 18, label: 'Unused stamps, cheque forms, stamp paper' },
  '4909': { rate: 18, label: 'Printed cards (greeting, wedding, postcards)' },
  '4911': { rate: 18, label: 'Other printed matter (posters, catalogues, calendars)' },
  '9608': { rate: 18, label: 'Ball pens, felt-tip pens, markers' },
  '9609': { rate: 0,  label: 'Pencils, crayons, pastels, chalk' },

  // ─── IT / electronics ──────────────────────────────────────────
  '8471': { rate: 18, label: 'Computers, laptops, tablets' },
  '8473': { rate: 18, label: 'Parts & accessories for computers' },
  '8517': { rate: 18, label: 'Mobile phones, landline phones' },
  '8523': { rate: 18, label: 'Recorded media (CDs, DVDs, memory cards)' },
  '8528': { rate: 18, label: 'TVs, monitors, projectors' },
  '8536': { rate: 18, label: 'Electrical apparatus (switches, plugs)' },
  '8544': { rate: 18, label: 'Insulated wires & cables' },
  '9004': { rates: [5, 18], label: 'Spectacles: corrective 5%; sunglasses, other goggles 18%' },

  // ─── Furniture, hardware, building ─────────────────────────────
  '7308': { rate: 18, label: 'Structures of iron / steel' },
  '7318': { rate: 18, label: 'Screws, bolts, nuts, washers' },
  '9401': { rate: 18, label: 'Seats, chairs, sofas (bamboo / cane: 5%)' },
  '9403': { rate: 18, label: 'Other furniture (bamboo / cane: 5%)' },
  '9405': { rate: 18, label: 'Lamps, light fittings (kerosene lanterns, handcrafted lamps: 5%)' },
  '6810': { rate: 18, label: 'Cement / concrete articles (sand-lime bricks: 5%)' },
  '6907': { rate: 18, label: 'Ceramic tiles, mosaic cubes' },
  '2523': { rate: 18, label: 'Cement' },

  // ─── Health, cosmetics, cleaning ───────────────────────────────
  '3004': { rate: 5,  label: 'Medicines, packed for retail (some life-saving drugs 0%)' },
  '3005': { rate: 5,  label: 'Wadding, gauze, bandages' },
  '3305': { rates: [5, 18], label: 'Hair care: hair oil, shampoo 5%; dyes, gels, other 18%' },
  '330510': { rate: 5, label: 'Shampoo' },
  '3401': { rates: [5, 18], label: 'Soap: toilet soap bars 5%; liquid, industrial soap 18%' },
  '340111': { rate: 5, label: 'Toilet soap bars / cakes' },
  '3402': { rate: 18, label: 'Detergents, cleaning preparations' },

  // ─── Automotive (compensation cess ended 22 Sep 2025) ─────────
  '8703': { rates: [5, 18, 40], label: 'Cars: electric 5%; small (petrol ≤1200cc / diesel ≤1500cc, ≤4 m) 18%; others 40%' },
  '8711': { rates: [5, 18, 40], label: 'Two-wheelers: electric 5%; up to 350cc 18%; above 350cc 40%' },
  '4011': { rate: 18, label: 'New tyres (bicycle, tractor tyres: 5%)' },

  // ─── Packaging & other common ──────────────────────────────────
  '3923': { rate: 18, label: 'Plastic articles for packaging' },
  '4819': { rates: [5, 18], label: 'Paper packaging: cartons, boxes 5%; other containers 18%' },
  '481910': { rate: 5, label: 'Cartons, boxes of corrugated paper / board' },
  '481920': { rate: 5, label: 'Folding cartons, boxes of non-corrugated paper / board' },
  '7013': { rate: 18, label: 'Glassware for table, kitchen, decoration' },
  '9615': { rate: 5,  label: 'Combs, hair clips, hairpins' },
};

// SAC (services). Most are 18%; the ones whose rate depends on the
// exact service or on ITC are marked with `rates` so they are not filled.
export const SAC_RATES = {
  '9954': { rates: [1, 5, 18], label: 'Construction: works contract 18%; residential flats 5% (affordable 1%)' },
  '9963': { rates: [5, 18], label: 'Restaurants, hotel rooms up to ₹7,500 a night 5%; costlier rooms 18%' },
  '9964': { rates: [0, 5, 18], label: 'Passenger transport: rate depends on mode and class' },
  '9965': { rates: [5, 18], label: 'Goods transport (GTA): 5% without ITC or 18% with ITC' },
  '9967': { rate: 18, label: 'Supporting services for transport' },
  '9971': { rate: 18, label: 'Financial services (individual life / health insurance: exempt)' },
  '9972': { rates: [0, 18], label: 'Real estate services (renting a home to live in: exempt)' },
  '9973': { rates: [5, 18, 40], label: 'Leasing / rental of goods: same rate as the goods' },
  '9981': { rate: 18, label: 'Research and development services' },
  '9982': { rate: 18, label: 'Legal and accounting services' },
  '9983': { rate: 18, label: 'Consulting, management, technical services' },
  '9984': { rate: 18, label: 'Telecommunications, broadcasting services' },
  '9985': { rate: 18, label: 'Support services (BPO, HR, security)' },
  '9986': { rates: [0, 18], label: 'Support services to agriculture, mining (many farm services exempt)' },
  '9987': { rate: 18, label: 'Maintenance, repair & installation (except construction)' },
  '9988': { rates: [5, 18], label: 'Job work: textiles, jewellery, printing, pharma etc. 5%; others 18%' },
  '9989': { rate: 18, label: 'Other manufacturing services' },
  '9992': { rate: 18, label: 'Coaching, training (recognised schools / colleges: exempt)' },
  // Health care by clinical establishments and doctors is exempt
  // (Notification 12/2017-CT(Rate), entry 74).
  '9993': { rate: 0,  label: 'Human health services (exempt)' },
  '9994': { rates: [5, 18], label: 'Sewage, waste management (effluent / bio-medical plants 5%)' },
  '9995': { rate: 18, label: 'Membership, professional bodies' },
  '9996': { rates: [5, 18, 40], label: 'Recreation, events: most 18%; cinema ticket ≤₹100 5%; casinos, IPL-type events 40%' },
  '9997': { rates: [5, 18], label: 'Other services: salon, spa, gym, yoga 5% (no ITC); laundry, misc 18%' },
  '99972': { rate: 5, label: 'Beauty and physical well-being (salon, spa, gym, yoga), no ITC' },
  // Software development is SAC 998314 (under 9983).
  '998314': { rate: 18, label: 'Software development / IT services' },
};

/*
 * Resolve the table entry for an HSN / SAC code, or null.
 * Codes starting with 99 are looked up in SAC_RATES.
 */
export function suggestGstRate(hsnOrSac) {
  if (!hsnOrSac) return null;
  const clean = String(hsnOrSac).replace(/\s+/g, '');
  if (!/^\d{4,8}$/.test(clean)) return null;
  const table = clean.startsWith('99') ? SAC_RATES : HSN_RATES;
  for (let len = clean.length; len >= 4; len--) {
    const hit = table[clean.slice(0, len)];
    if (hit) return hit;
  }
  return null;
}

// The rate to auto-fill, or null when the code has no single usual rate.
export function autoFillRate(hsnOrSac) {
  const s = suggestGstRate(hsnOrSac);
  return s && typeof s.rate === 'number' ? s.rate : null;
}

// "5%" or "5% / 18%" for the hint under the HSN box.
export function rateText(s) {
  return s.rates ? s.rates.map(r => `${r}%`).join(' / ') : `${s.rate}%`;
}
