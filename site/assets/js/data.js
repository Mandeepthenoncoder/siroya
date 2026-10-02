/* Siroya site content. Single source for collections, products, stores.
   Images: put files under assets/img/... and set the path. Any empty
   image renders a labelled placeholder so the layout can be reviewed first. */

window.SIROYA = {
  site: {
    name: "Siroya Jewellers",
    tagline: "Your Family Jewellers",
    since: 1976,
    whatsapp: "971565006398", // from current siroya.com, confirm before launch
    phone: "+971 4 225 4254",
    email: "accounts@siroya.com",
    socials: { instagram: "", facebook: "", youtube: "" }
  },

  categories: [
    { slug: "necklaces", name: "Necklaces", img: "assets/img/categories/necklaces.jpg", description: "From temple haarams to diamond rivieres, necklaces for every celebration." },
    { slug: "bangles", name: "Bangles", img: "assets/img/categories/bangles.jpg", description: "Bangles, kadas and bracelets, from bridal sets to everyday gold." },
    { slug: "earrings", name: "Earrings", img: "assets/img/categories/earrings.jpg", description: "Jhumkas, studs and hoops, chosen to frame every face and every occasion." },
    { slug: "rings", name: "Rings", img: "assets/img/categories/rings.jpg", description: "Solitaires, bands and cocktail rings for the promises you keep." },
    { slug: "chains", name: "Chains", img: "assets/img/categories/chains.jpg", description: "Fine, rope and statement chains in gold, made to wear every day." },
    { slug: "pendants", name: "Pendants", img: "assets/img/categories/pendants.jpg", description: "Pendants of devotion and delight, from Lakshmi coins to diamond drops." }
  ],

  collections: [
    {
      slug: "sanskriti", name: "Sanskriti", kind: "Temple Jewellery",
      short: "Temple jewellery for weddings, festivals and family celebrations.",
      intro: "Sanskriti carries the craft of South Indian temple jewellery forward. Deities, lotus motifs and gold worked by hand, made to be worn on the days your family will remember.",
      hero: "assets/img/collections/sanskriti-hero.jpg", cover: "assets/img/collections/sanskriti-cover.jpg",
      chapters: [
        { title: "Carved from devotion", text: "Each motif traces back to temple architecture: the lotus, the peacock, the goddess Lakshmi. Our karigars keep these forms true to their origin.", img: "assets/img/collections/sanskriti-story.jpg" },
        { title: "Made for the mandap", text: "Long haarams, layered necklaces and kasu malai, chosen with care for the bride and for every woman of the family beside her.", img: "assets/img/collections/sanskriti-detail.jpg" }
      ],
      quote: "Traditions carried forward, one generation to the next."
    },
    {
      slug: "rangmahal", name: "Rangmahal", kind: "Precious Stone Jewellery",
      short: "Rubies, emeralds and sapphires, set in gold.",
      intro: "Rangmahal means palace of colour. Rubies, emeralds and sapphires, selected for depth of colour and set in gold with the confidence of decades of design expertise.",
      hero: "assets/img/collections/rangmahal-hero.jpg", cover: "assets/img/collections/rangmahal-cover.jpg",
      chapters: [
        { title: "Colour, chosen with care", text: "Every stone is selected for its colour first. Deep pigeon-blood reds, forest emeralds, cornflower sapphires.", img: "assets/img/collections/rangmahal-story.jpg" },
        { title: "From the royal courts", text: "Polki-inspired settings and Mughal motifs, reworked for celebrations today.", img: "assets/img/collections/rangmahal-detail.jpg" }
      ],
      quote: "Jewellery that connects generations."
    },
    {
      slug: "prestige", name: "Prestige", kind: "Natural Diamond Jewellery",
      short: "Natural diamonds, masterfully designed.",
      intro: "Prestige brings together natural diamonds and designs curated from across the world. Clear value, transparent certification and craftsmanship you can see.",
      hero: "assets/img/collections/prestige-hero.jpg", cover: "assets/img/collections/prestige-cover.jpg",
      chapters: [
        { title: "Light, held in gold", text: "Settings designed to let every diamond catch the light, from everyday studs to bridal necklaces.", img: "assets/img/collections/prestige-story.jpg" },
        { title: "Chosen with confidence", text: "Certified natural diamonds and clear guidance from our team, so every decision feels sure.", img: "assets/img/collections/prestige-detail.jpg" }
      ],
      quote: "Made for your moments."
    },
    {
      slug: "evermore", name: "Evermore", kind: "Lab Grown Diamond Jewellery",
      short: "Lab grown diamonds, crafted for today.",
      intro: "Evermore offers the brilliance of diamond with a modern choice. Lab grown diamonds in designs made for the way you dress every day.",
      hero: "assets/img/collections/evermore-hero.jpg", cover: "assets/img/collections/evermore-cover.jpg",
      chapters: [
        { title: "A modern choice", text: "Physically and chemically diamond, grown with care and set in contemporary designs.", img: "assets/img/collections/evermore-story.jpg" },
        { title: "Everyday brilliance", text: "Rings, tennis bracelets and studs made to be worn often, not saved for once a year.", img: "assets/img/collections/evermore-detail.jpg" }
      ],
      quote: "Rooted in heritage. Inspired by the future."
    },
    {
      slug: "divine-solitaire", name: "Divine Solitaire", kind: "Investment Grade Diamonds",
      short: "Hearts and arrows solitaires with assured value.",
      intro: "Divine Solitaire offers investment grade natural diamonds with a perfect hearts and arrows cut, backed by an assurance on value. A solitaire chosen once, kept for a lifetime.",
      hero: "assets/img/collections/divine-solitaire-hero.jpg", cover: "assets/img/collections/divine-solitaire-cover.jpg",
      chapters: [
        { title: "Hearts and arrows", text: "Cut to precise proportions so that eight hearts and eight arrows appear under a special viewer. The mark of a perfectly cut solitaire.", img: "assets/img/collections/divine-solitaire-cover.jpg" },
        { title: "Value, made clear", text: "Every solitaire comes with documented grading and a clear value assurance. Our team explains every term before you choose.", img: "assets/img/collections/divine-solitaire-detail.jpg" }
      ],
      quote: "Transparent value, backed by decades of expertise."
    },
    {
      slug: "nexa", name: "Nexa", kind: "18K Lightweight Jewellery",
      short: "18K gold, lightweight and made for every day.",
      intro: "Nexa is 18K gold designed for daily wear. Light on the skin, easy to layer and right for the office, the weekend and everything between.",
      hero: "assets/img/collections/nexa-hero.jpg", cover: "assets/img/collections/nexa-cover.jpg",
      chapters: [
        { title: "Light by design", text: "Clean lines and lightweight construction, made to be worn from morning to evening.", img: "assets/img/collections/nexa-cover.jpg" },
        { title: "Made to layer", text: "Fine chains, huggies and stackable rings that work together.", img: "assets/img/collections/nexa-detail.jpg" }
      ],
      quote: "Crafted for today."
    },
    {
      slug: "iconyx", name: "Iconyx", kind: "Men's Jewellery",
      short: "Chains, kadas and rings for men.",
      intro: "Iconyx is jewellery designed for men. Bold chains, kadas, bracelets and rings with clean, confident forms.",
      hero: "assets/img/collections/iconyx-hero.jpg", cover: "assets/img/collections/iconyx-cover.jpg",
      chapters: [
        { title: "Confident, never loud", text: "Weight, texture and finish matter more than ornament. Designs that sit well every day.", img: "assets/img/collections/iconyx-cover.jpg" },
        { title: "For the milestones", text: "The wedding kada, the first gold chain, the ring you will wear for decades.", img: "assets/img/collections/iconyx-detail.jpg" }
      ],
      quote: "A legacy of craftsmanship and design."
    },
    {
      slug: "toons", name: "Toons", kind: "Kids' Jewellery",
      short: "Playful, lightweight gold for little ones.",
      intro: "Toons is gold jewellery for children. Playful motifs, smooth finishes and secure fittings, made for naming ceremonies, birthdays and first festivals.",
      hero: "assets/img/collections/toons-hero.jpg", cover: "assets/img/collections/toons-cover.jpg",
      chapters: [
        { title: "Their first gold", text: "Bracelets, earrings and pendants sized for little hands and ears, with rounded edges and secure clasps.", img: "assets/img/collections/toons-cover.jpg" },
        { title: "Gifts for the family album", text: "Jewellery for the moments families photograph and remember.", img: "assets/img/collections/toons-detail.jpg" }
      ],
      quote: "Celebrating life's milestones together."
    }
  ],

  // Products. Replace with the real catalogue; the layout only needs these fields.
  products: [],

  stores: [
    { slug: "deira", name: "Deira Gold Souk", address: "Shop 12, Building 6B, Hind Plaza, New Gold Souq Extension, Deira, Dubai", hours: "", phone: "+971 52 546 4326", map: "https://g.co/kgs/RuXck2w", img: "assets/img/stores/deira.jpg" },
    { slug: "karama", name: "Karama Centre", address: "Shop 44-46, Karama Center, Al Karama, Dubai", hours: "", phone: "+971 50 816 6261", map: "https://g.co/kgs/JdPmHgx", img: "assets/img/stores/karama.jpg" },
    { slug: "qusais", name: "Al Qusais", address: "Sheikh Colony, Al Qusais 1, Dubai", hours: "", phone: "+971 50 185 3668", map: "https://g.co/kgs/5NuUgSj", img: "assets/img/stores/qusais.jpg" },
    { slug: "meena-bazaar", name: "Meena Bazaar", address: "Cosmo Lane, Meena Bazaar, Al Fahidi, Bur Dubai", hours: "", phone: "", map: "https://g.co/kgs/wdcrg2y", img: "assets/img/stores/meena-bazaar.jpg" }
  ]
};

/* Placeholder catalogue so collection and product layouts can be reviewed.
   Remove this block once real products are added above. */
(function seedPlaceholders(S) {
  if (S.products.length) return;
  const types = {
    sanskriti: ["Lakshmi Haaram", "Kasu Mala", "Peacock Jhumkas", "Temple Vanki", "Lotus Necklace", "Nagas Bangles", "Mango Mala", "Kemp Choker"],
    rangmahal: ["Ruby Choker", "Emerald Drops", "Sapphire Bangle", "Polki Necklace", "Ruby Studs", "Emerald Ring", "Navratna Pendant", "Sapphire Haar"],
    prestige: ["Diamond Rivière", "Halo Studs", "Bridal Necklace", "Eternity Band", "Diamond Jhumkas", "Cluster Ring", "Drop Pendant", "Diamond Kada"],
    evermore: ["Tennis Bracelet", "Solitaire Ring", "Hoop Earrings", "Line Necklace", "Halo Pendant", "Stacking Band", "Ear Climbers", "Bezel Studs"],
    "divine-solitaire": ["Classic Solitaire Ring", "Solitaire Studs", "Solitaire Pendant", "Three-Stone Ring", "Solitaire Band", "Halo Solitaire"],
    nexa: ["Paperclip Chain", "Huggie Hoops", "Stacking Ring", "Bar Pendant", "Link Bracelet", "Twist Studs", "Layered Chain", "Charm Bracelet"],
    iconyx: ["Curb Chain", "Wedding Kada", "Signet Ring", "Rope Chain", "Cuban Bracelet", "Band Ring"],
    toons: ["Teddy Studs", "Star Pendant", "Nazariya Bracelet", "Butterfly Earrings", "Name Bracelet", "Heart Charm"]
  };
  const catOf = n => /chain/i.test(n) ? "chains"
    : /mala|haar|necklace|choker|rivi|line/i.test(n) ? "necklaces"
    : /bangle|kada|bracelet|vanki|cuban/i.test(n) ? "bangles"
    : /stud|jhumka|drop|hoop|huggie|earring|climber/i.test(n) ? "earrings"
    : /ring|band|signet/i.test(n) ? "rings"
    : "pendants";
  const metal = { nexa: "18K Gold", evermore: "18K Gold, Lab Grown Diamond", prestige: "18K Gold, Natural Diamond", "divine-solitaire": "18K Gold, Solitaire", rangmahal: "22K Gold, Precious Stones" };
  Object.entries(types).forEach(([c, names]) => names.forEach((n, i) => S.products.push({
    id: `${c}-${i + 1}`,
    code: `SJ-${c.slice(0, 3).toUpperCase()}-${String(1040 + i * 7)}`,
    name: n, collection: c, category: catOf(n),
    metal: metal[c] || "22K Gold",
    weight: "", stones: "",
    images: ["assets/img/products/ring-1.jpg", "assets/img/products/ring-2.jpg"], // temporary: same ring for all
    description: ""
  })));
})(window.SIROYA);
