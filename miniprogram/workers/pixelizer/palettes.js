const PALETTES = {
  dreamscape8: {
    name: "Dreamscape8",
    colors: ["#c9cca1", "#caa05a", "#ae6a47", "#8b4049", "#543344", "#515262", "#63787d", "#8ea091"]
  },
  "skin-red-pollen8": {
    name: "Pollen8",
    colors: ["#6b2629", "#a4373f", "#d85a5a", "#ffa7a5", "#ffe07e", "#ffe7d6", "#72dcbb", "#34acba"]
  },
  "skin-hero-kodak-yellow": { name: "Kodak Yellow Tone", colors: ["#f7cd45", "#060606"] },
  "blue-tone": { name: "Blue Tone", colors: ["#0101fb", "#060606"] },
  "red-tone": { name: "Red Tone", colors: ["#fd0500", "#060606"] },
  "gray-tone": { name: "Gray Tone", colors: ["#c6cbb3", "#060606"] },
  "oil-6": { name: "Oil 6", colors: ["#fbf5ef", "#f2d3ab", "#c69fa5", "#8b6d9c", "#494d7e", "#272744"] },
  slso8: { name: "SLSO8", colors: ["#0d2b45", "#203c56", "#544e68", "#8d697a", "#d08159", "#ffaa5e", "#ffd4a3", "#ffecd6"] },
  blessing: { name: "Blessing", colors: ["#74569b", "#96fbc7", "#f7ffae", "#ffb3cb", "#d8bfd8"] },
  nyx8: { name: "Nyx8", colors: ["#08141e", "#0f2a3f", "#20394f", "#f6d6bd", "#c3a38a", "#997577", "#816271", "#4e495f"] },
  "ammo-8": { name: "Ammo-8", colors: ["#040c06", "#112318", "#1e3a29", "#305d42", "#4d8061", "#89a257", "#bedc7f", "#eeffcc"] },
  "aap-64": {
    name: "AAP-64",
    colors: [
      "#060608", "#141013", "#3b1725", "#73172d", "#b4202a", "#df3e23", "#fa6a0a", "#f9a31b",
      "#ffd541", "#fffc40", "#d6f264", "#9cdb43", "#59c135", "#14a02e", "#1a7a3e", "#24523b",
      "#122020", "#143464", "#285cc4", "#249fde", "#20d6c7", "#a6fcdb", "#ffffff", "#fef3c0",
      "#fad6b8", "#f5a097", "#e86a73", "#bc4a9b", "#793a80", "#403353", "#242234", "#221c1a",
      "#322b28", "#71413b", "#bb7547", "#dba463", "#f4d29c", "#dae0ea", "#b3b9d1", "#8b93af",
      "#6d758d", "#4a5462", "#333941", "#422433", "#5b3138", "#8e5252", "#ba756a", "#e9b5a3",
      "#e3e6ff", "#b9bffb", "#849be4", "#588dbe", "#477d85", "#23674e", "#328464", "#5daf8d",
      "#92dcba", "#cdf7e2", "#e4d2aa", "#c7b08b", "#a08662", "#796755", "#5a4e44", "#423934"
    ]
  },
  ink: { name: "Ink", colors: ["#1f1f29", "#413a42", "#596070", "#96a2b3", "#eaf0d8"] },
  "blk-nx64": {
    name: "BLK NX64",
    colors: [
      "#000000", "#12173d", "#293268", "#464b8c", "#6b74b2", "#909edd", "#c1d9f2", "#ffffff",
      "#a293c4", "#7b6aa5", "#53427f", "#3c2c68", "#431e66", "#5d2f8c", "#854cbf", "#b483ef",
      "#8cff9b", "#42bc7f", "#22896e", "#14665b", "#0f4a4c", "#0a2a33", "#1d1a59", "#322d89",
      "#354ab2", "#3e83d1", "#50b9eb", "#8cdaff", "#53a1ad", "#3b768f", "#21526b", "#163755",
      "#008782", "#00aaa5", "#27d3cb", "#78fae6", "#cdc599", "#988f64", "#5c5d41", "#353f23",
      "#919b45", "#afd370", "#ffe091", "#ffaa6e", "#ff695a", "#b23c40", "#ff6675", "#dd3745",
      "#a52639", "#721c2f", "#b22e69", "#e54286", "#ff6eaf", "#ffa5d5", "#ffd3ad", "#cc817a",
      "#895654", "#61393b", "#3f1f3c", "#723352", "#994c69", "#c37289", "#f29faa", "#ffccd0"
    ]
  },
  crimson: { name: "Crimson", colors: ["#eff9d6", "#ba5044", "#7a1c4b", "#1b0326"] },
  "fiery-dreams": { name: "Fiery Dreams", colors: ["#251534", "#461753", "#701355", "#a41759", "#cd2561", "#de5568", "#f0a383", "#fae4b9", "#fffef0"] },
  "k-angels-away-screen": {
    name: "K-Angel",
    colors: [
      "#946aa3", "#8e6bff", "#589adf", "#14c8f9", "#6adcea", "#a5b0ce", "#afabf3", "#fe89d9",
      "#f3bbe7", "#aadcff", "#8afdfe", "#bafff5", "#d2d2d5", "#d7c5f1", "#ebccf2", "#dae8ff",
      "#feecfa", "#fcfeff"
    ]
  },
  "nopal-12": { name: "NOPAL-12", colors: ["#e2e4df", "#c5cfc4", "#a8b5ae", "#92929c", "#ffeced", "#fbd4d2", "#f1b4b4", "#cca3a3", "#f1eab6", "#e4dba0", "#cac18a", "#aba47b"] },
  saccharide: {
    name: "Saccharide",
    colors: [
      "#c09dc3", "#ebaebc", "#ffcabb", "#ffe5ba", "#c8dcbe", "#a0cac2", "#87afbb", "#9dccd7",
      "#c3deeb", "#a6c7e7", "#97abd4", "#8b8fb0", "#b5a5d3", "#e1b6db", "#ffcbd7", "#ffe8dc",
      "#f4d2cd", "#e2b7be", "#c19caf", "#7d7390", "#ada3b9", "#cbbfcf", "#e5d9e1", "#fff7f0"
    ]
  },
  "sailor-moon-background": {
    name: "Sailor Moon BG",
    colors: [
      "#bdffff", "#5db8ca", "#5cadc3", "#378dae", "#3c7596", "#1e6da0", "#144d70", "#00245c",
      "#a0e1d9", "#80bcb9", "#438d98", "#07687b", "#065866", "#06505c", "#054752", "#d998c3",
      "#d48cd4", "#8797c5", "#e055b8", "#b65bb2", "#675390", "#3c377b", "#e8f8d7", "#dddac7",
      "#fdd3b0", "#ffdac9", "#ffcec7", "#d9bed0"
    ]
  },
  "st-24": {
    name: "ST 24",
    colors: [
      "#111126", "#141433", "#17174d", "#281d73", "#3e2680", "#6c29a6", "#8136b3", "#ba41d9",
      "#de73e5", "#ed9df2", "#e9c2f2", "#ffffff", "#dae7f2", "#9de7f2", "#73c7e5", "#4192d9",
      "#3670b3", "#295ba6", "#23468c", "#1d2873", "#2953a6", "#3663b3", "#417ed9", "#73a8e5"
    ]
  },
  "st-8-phoenix": { name: "ST 8 Phoenix", colors: ["#330d10", "#4d130f", "#732017", "#992817", "#bf481d", "#d97e16", "#e5be22", "#f2e749"] },
  starry13: { name: "starry13", colors: ["#4d456d", "#795389", "#a4628a", "#d38595", "#e9a7a3", "#f0d7b1", "#aec6a5", "#7ba1ab", "#657ba3", "#5a5f92", "#7d7db7", "#ad96cf", "#e6addd"] },
  sweethope: { name: "SweetHope", colors: ["#615e85", "#9c8dc2", "#d9a3cd", "#ebc3a7", "#e0e0dc", "#a3d1af", "#90b4de", "#717fb0"] },
  "dream-haze-8": { name: "Dream Haze 8", colors: ["#3c42c4", "#6e51c8", "#a065cd", "#ce79d2", "#d68fb8", "#dda2a3", "#eac4ae", "#f4dfbe"] }
};

function getSortedPalettes() {
  return Object.keys(PALETTES)
    .map((key) => ({ key, ...PALETTES[key] }))
    .sort((a, b) => a.colors.length - b.colors.length);
}

module.exports = {
  PALETTES,
  getSortedPalettes
};
