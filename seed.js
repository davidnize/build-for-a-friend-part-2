// The shelf a brand-new account starts with. Five titles in each category.

const CATEGORIES = ["Slice of Life", "Harem", "Love Triangle", "Movies"];

const SEED = [
  {
    id: "horimiya",
    title: "Horimiya",
    year: 2021,
    category: "Slice of Life",
    note: "Hori and Miyamura look ordinary at school, and each is hiding a very different life at home."
  },
  {
    id: "kimi-ni-todoke",
    title: "Kimi ni Todoke",
    year: 2009,
    category: "Slice of Life",
    note: "Classmates call shy Sawako Sadako because of how she looks, until a kind boy starts to know her."
  },
  {
    id: "tsurezure-children",
    title: "Tsurezure Children",
    year: 2017,
    category: "Slice of Life",
    note: "Short stories about high-school couples who are earnest, awkward, and bad at saying how they feel."
  },
  {
    id: "wotakoi",
    title: "Wotakoi: Love is Hard for Otaku",
    year: 2018,
    category: "Slice of Life",
    note: "Two office workers who love games and fandom try dating without pretending to be someone else."
  },
  {
    id: "tsuki-ga-kirei",
    title: "Tsuki ga Kirei",
    year: 2017,
    category: "Slice of Life",
    note: "Kotaro and Akane, quiet third-years, start a shy first romance between club practice and exams."
  },
  {
    id: "quintuplets",
    title: "The Quintessential Quintuplets",
    year: 2019,
    category: "Harem",
    note: "Futaro is hired to tutor five quintuplet sisters who are failing their classes together."
  },
  {
    id: "nisekoi",
    title: "Nisekoi",
    year: 2014,
    category: "Harem",
    note: "Raku, heir to a yakuza family, has to fake a romance with the daughter of a rival gang."
  },
  {
    id: "saekano",
    title: "Saekano: How to Raise a Boring Girlfriend",
    year: 2015,
    category: "Harem",
    note: "Tomoya recruits a circle of girls to help him finish the dating sim he is set on making."
  },
  {
    id: "we-never-learn",
    title: "We Never Learn",
    year: 2019,
    category: "Harem",
    note: "Nariyuki tutors three genius classmates who stumble the moment they leave their best subject."
  },
  {
    id: "twgok",
    title: "The World God Only Knows",
    year: 2010,
    category: "Harem",
    note: "Dating-sim master Keima must make real girls fall in love with him to free hidden spirits."
  },
  {
    id: "white-album-2",
    title: "White Album 2",
    year: 2013,
    category: "Love Triangle",
    note: "Haruki, Setsuna, and Kazusa form a light-music trio, then a love triangle pulls them apart."
  },
  {
    id: "toradora",
    title: "Toradora!",
    year: 2008,
    category: "Love Triangle",
    note: "Taiga and Ryuuji pair up to win their crushes, and end up falling for each other."
  },
  {
    id: "kokoro-connect",
    title: "Kokoro Connect",
    year: 2012,
    category: "Love Triangle",
    note: "Five friends start swapping bodies, and a love triangle among them comes to the surface."
  },
  {
    id: "golden-time",
    title: "Golden Time",
    year: 2013,
    category: "Love Triangle",
    note: "College freshman Banri, missing his memories, is torn between Kouko and a friend from his past."
  },
  {
    id: "ao-haru-ride",
    title: "Ao Haru Ride",
    year: 2014,
    category: "Love Triangle",
    note: "Futaba meets her middle-school crush Kou again, while a classmate falls for him too."
  },
  {
    id: "your-name",
    title: "Your Name",
    year: 2016,
    category: "Movies",
    note: "Taki and Mitsuha wake in each other's bodies and search for one another across time."
  },
  {
    id: "a-silent-voice",
    title: "A Silent Voice",
    year: 2016,
    category: "Movies",
    note: "Shoya tries to make amends with Shoko, the deaf classmate he bullied as a child."
  },
  {
    id: "josee",
    title: "Josee, the Tiger and the Fish",
    year: 2020,
    category: "Movies",
    note: "Student Tsuneo meets Josee, a fierce artist who uses a wheelchair and has seldom left home."
  },
  {
    id: "pancreas",
    title: "I Want to Eat Your Pancreas",
    year: 2018,
    category: "Movies",
    note: "A reserved classmate keeps the secret of a lively girl living with a terminal illness."
  },
  {
    id: "weathering-with-you",
    title: "Weathering With You",
    year: 2019,
    category: "Movies",
    note: "Runaway Hodaka meets Hina, whose prayer can clear Tokyo's unending rain."
  }
];

module.exports = { CATEGORIES, SEED };
