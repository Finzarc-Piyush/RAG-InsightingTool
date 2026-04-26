---
id: geography-and-channel-codes
title: Geography and Channel Codes — Indian FMCG
category: glossary
priority: 13
enabledByDefault: true
version: 2026-04-26
---

This pack disambiguates the geography and channel codes commonly used in Marico's MIS and dataset columns. When a column or filter uses one of these codes, treat the definition here as authoritative.

## Indian region codes

- **North** — Delhi NCR, Punjab, Haryana, Himachal Pradesh, Jammu & Kashmir, Uttarakhand, Uttar Pradesh, Chandigarh.
- **South** — Tamil Nadu, Karnataka, Andhra Pradesh, Telangana, Kerala, Puducherry. Marico's coconut-oil heartland.
- **East** — West Bengal, Bihar, Jharkhand, Odisha, the seven North-East states, Assam, Sikkim. Strong for Nihar Naturals.
- **West** — Maharashtra, Gujarat, Goa, Madhya Pradesh, Chhattisgarh, Rajasthan, Daman & Diu, Dadra & Nagar Haveli.
- **Central** — sometimes carved out as Madhya Pradesh + Chhattisgarh + parts of Uttar Pradesh; convention varies by report.

## Common state-cluster groupings

- **HSM (Hindi Speaking Markets)** — UP, Bihar, MP, Rajasthan, Haryana, Delhi, Jharkhand, Chhattisgarh, Uttarakhand, Himachal. Used to track consumption in the largest demographic block.
- **Metros** — typically Mumbai, Delhi, Bengaluru, Kolkata, Chennai, Hyderabad. Sometimes extended to include Pune and Ahmedabad.
- **Tier 1 / Tier 2 / Tier 3 / Tier 4 towns** — population-based classification used in distribution planning. Tier 1 = metros + ~30 large cities; tiers descend with town size.
- **NCCS (New Consumer Classification System)** — A1/A2/B1/B2/C/D/E classification by household profile (occupation, education); replaces SEC. Higher = more affluent / educated.

## Channel codes

- **GT** — General Trade (kirana, traditional grocery, paan, chemist).
- **MT** — Modern Trade (organised supermarket / hypermarket chains).
- **E-Com** / **EC** — E-commerce marketplaces (Amazon, Flipkart, BigBasket, Nykaa).
- **Q-Com** / **QC** — Quick commerce (Blinkit, Zepto, Instamart, BB Now, Flipkart Minutes).
- **D2C** — Direct-to-consumer (own websites).
- **CSD** — Canteen Stores Department (defence / paramilitary canteens). Specific channel with its own pricing.
- **HORECA** — Hotels, Restaurants, Cafés. Out-of-home / institutional.
- **Institutional** — bulk sales to institutions (corporate gifting, large kitchens).
- **Cash & Carry** — wholesale formats like Metro Cash & Carry (now Reliance), Walmart India (now Flipkart Wholesale).

## International codes (Marico-specific)

- **BD** — Bangladesh. Marico's largest international market; Parachute and value-added hair oils dominate. Operates as Marico Bangladesh Ltd (MBL).
- **VN** — Vietnam. Marico's second-largest international market. Operates as Marico South East Asia (MSEA, formerly ICP). Male grooming (X-Men, Marino, Code 10) is the largest pillar; women's personal care (L'Ovité, Hair Code, Q1) and home/kitchen (Ozone, Vegy, Thuan Phat) round out the portfolio. See the Vietnam portfolio pack for the full brand list.
- **MENA** — Middle East and North Africa region (Egypt, UAE, Saudi Arabia).
- **SA** — South Africa.

## Vietnam-specific region codes

When a Vietnam dataset is loaded, expect these region cuts (NOT interchangeable with the India region codes above):

- **South / HCMC** — Ho Chi Minh City and the surrounding Southern provinces. Largest commercial region.
- **North / Hanoi** — Hanoi and Northern provinces.
- **Central / Da Nang** — Central Vietnam, anchored on Da Nang.
- **Mekong Delta** — South-Western agricultural region; rural-skewed.
- **Highlands / Tay Nguyen** — Central Highlands; rural and coffee-growing.

## Patterns to keep in mind

- "Region" in the dataset usually means the four-region (N/S/E/W) or five-region (with Central) split — confirm which convention applies.
- "Tier" classification of towns is population-based, not consumption-based; a Tier 2 town in Punjab can be more affluent than a Tier 1 town elsewhere.
- HSM as a cut is more useful than "rural" alone when the question is about Hindi-belt consumption.
- Quick commerce (Q-com) is a distinct channel from e-commerce (E-com); they have different baskets, repeat rates and assortment depth — treat them separately.
- For international questions, Bangladesh (BD) is the largest single international market and the one most likely to be material in a portfolio-level slice.
