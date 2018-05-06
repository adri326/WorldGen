let WorldGen = require("./index");

let generator = new WorldGen();

const {
  grounds,
  others,
  elements
} = require("./test.json");

generator.set_grounds(grounds)
generator.set_others(others)
generator.set_elements(elements)

let world = generator.generate(32, 16)

console.log(world[9][5])
