const Simplex = require("simplex-noise");

module.exports = class WorldGen {
  constructor() {
    this.grounds = [];
    this.elements = [];
    this.others = [];
    this.settings = {
      scale: 0.125,
      octaves: 16,
      octave_scale_factor: 2,
      octave_intensity_factor: 0.125,
      seed: 0,
      smoothen: 10,
      smoothen_amount: 0.01,
      smoothen_radius: 3,
      height_contrast: 1.25,
      height_shift: 0,
      y_climate_influence: 0.75,
      grounds_smoothen: 2,
      grounds_smoothen_amount: 0.1,
      grounds_smoothen_radius: 3,
      grounds_threshold: 0.1,
      elements_smoothen: 5,
      elements_smoothen_amount: 0.1,
      elements_smoothen_radius: 3,
      elements_threshold: 0.1
    };
  }

  set_grounds(grounds) {
    this.grounds = this.grounds.concat(grounds);
  }

  set_elements(elements) {
    this.elements = this.elements.concat(elements);
  }

  set_others(others) {
    this.others = this.others.concat(others);
  }

  set_settings(settings) {
    Object.assign(this.settings, settings);
  }

  generate(width, height) {
    let s = this.settings;

    let hm = this._gen_hm(width, height);

    let map = hm.map(row => row.map(h => { // tile initialization
      return {
        height: Math.min(Math.max(h, 0), 1), // clamp height to [0, 1]
        elements: [],
        grounds: [],
        others: [],
        humidity: 0,
        temperature: 0,
        slope: []
      };
    }));

    let sun_angle = Math.PI / 6;

    through(map, (tile, x, y) => { // basic tile setting: slope, humidity, temperature and grounds
      tile.slope = get_slope(map, x, y);

      tile.humidity = Math.min(Math.max(.5
        + tile.slope[1] * Math.sin(sun_angle)
        + 0.5 * (Math.cos((y / height - .5) * Math.PI * s.y_climate_influence) - .5)
      , 0), 1);

      tile.temperature = sigma(tile.height ** 2)
        + 0.5 * (Math.cos((y / height - .5) * Math.PI * s.y_climate_influence) - 1)

      this.grounds.forEach(ground => {
        this._add_ground(ground, tile, x, y);
      });

      this._normalise(tile, "grounds");
    });

    if (s.grounds_smoothen) {
      this._blur(map, "grounds");
    }

    through(map, (tile, x, y) => {
      this.others.forEach(other => {
        this._add_other(other, tile, x, y);
      });
      this.elements.forEach(element => {
        this._add_element(element, tile, x, y);
      });
      this._normalise(tile, "elements")
    });

    if (s.elements_smoothen) {
      this._blur(map, "elements");
    }

    return map;
  }

  _gen_hm(width, height) { // generates a heightmap
    let s = this.settings;

    let octave_simplexes = aww(s.octaves, i => new Simplex(String(s.seed + i * s.seed))); // the different octave simplexes
    let octave_sum = sum(0, s.octaves - 1, n => Math.pow(s.octave_intensity_factor, n)); // Σ(octave_intensity_factor ^ n)

    let map = aww(width, x => aww(height, y => { // basic height generation, simplex noise, multi-octave
      return sum(0, s.octaves - 1, n => (octave_simplexes[n].noise2D(
        x * s.scale * Math.pow(s.octave_scale_factor, n), // scale x
        y * s.scale * Math.pow(s.octave_scale_factor, n), // scale y
      ) + 1) / 2 // convert from [-1, 1] to [0, 1]
      * Math.pow(s.octave_intensity_factor, n)) / octave_sum; // intensity
    }));

    if (s.smoothen > 0) { // height smoothing process
      for (let step = 0; step < s.smoothen; step++) {
        map = aww(width, x => aww(height, y => {
          return gblur(map, x, y, s.smoothen_amount / s.scale, s.smoothen_radius);
        }));
      }
    }

    return map.map(row => row.map(h => (h - .5) * s.height_contrast + .5 + s.height_shift)); // height contrast + shift
  }

  _add_ground(ground, tile, x, y) {
    let {
      temperature,
      humidity,
      height,
      slope: [slope_x, slope_y]
    } = tile;

    let slope = Math.sqrt(slope_x ** 2 + slope_y ** 2);

    let simplex = new Simplex(String(this.settings.seed + 200) + ground.name);
    let prob = simplex.noise2D(
      x * this.settings.scale * (ground.noise_scale || 1),
      y * this.settings.scale * (ground.noise_scale || 1)
    ) / 2 + .5;

    if (ground.frequence) {
      if (prob > ground.frequence
          + (ground.height_frequence || 0) * height
          + (ground.slope_frequence || 0) * slope
          + (ground.humidity_frequence || 0) * humidity
          + (ground.temperature_frequence || 0) * temperature
        ) {
        return;
      }
      else {
        prob = prob / ground.frequence;
      }
    }

    const scalar_properties = {
      slope,
      height,
      humidity,
      temperature
    }

    for (let prop in scalar_properties) {
      let value = scalar_properties[prop];
      if (typeof ground[`min_${prop}`] !== "undefined" && ground[`min_${prop}`] > value) return; // min_[prop]
      if (typeof ground[`max_${prop}`] !== "undefined" && ground[`max_${prop}`] < value) return; // max_[prop]
    }

    tile.grounds.push({name: ground.name, amount: prob})
  }

  _normalise(tile, thing) {
    let es = sum(0, tile[thing].length - 1, n => {
      let element = tile[thing][n];
      let parent = this[thing].find(_ => _.name == element.name);
      if (typeof parent.priority === "undefined") return element.amount;
      else return element.amount * parent.priority;
    });
    tile[thing].forEach(element => {
      let parent_element = this[thing].find(_ => _.name == element.name);
      element.amount = element.amount / es * (parent_element.priority || 1);
    });
  }

  _blur(map, thing) {

    /*
      Blurs one [{name, amount}] property array of the map tiles, which key being `thing`
      This requires the following properties in `this.settings`:
        - ${thing}_smoothen
        - ${thing}_smoothen_amount
        - ${thing}_smoothen_radius
        - ${thing}_threshold (optional)
    */

    let s = this.settings;

    let width = map.length, height = map[0].length;

    let maps = this[thing].map(element =>
      map.map(row => row.map(tile => {
        let parent = tile[thing].find(e => e.name == element.name)
        if (!parent) {
          return 0;
        }
        else {
          return parent.amount;
        }
      }))
    );

    maps = maps.map(emap => {
      for (let n = 0; n < s[thing + "_smoothen"]; n++) {
        emap = aww(width, x => aww(height, y => {
          return gblur(emap, x, y, s[thing + "_smoothen_amount"], s[thing + "_smoothen_radius"]); // blurring process
        }));
      }
      return emap;
    });

    through(map, (tile, x, y) => {
      tile[thing] = maps.map((emap, i) => ( // map => ground (w/ name & amount)
        {
          name: this[thing][i].name,
          amount: emap[x][y]
        }
      )).filter(element => element.amount > s[thing + "_threshold"]); // threshold filter
      this._normalise(tile, thing); // gotta normalise again
    });
  }

  _add_other(other, tile, x, y) {
    let {
      temperature,
      humidity,
      height,
      slope: [slope_x, slope_y]
    } = tile;

    let slope = Math.sqrt(slope_x ** 2 + slope_y ** 2);

    const scalar_properties = {
      slope,
      height,
      humidity,
      temperature
    }

    for (let prop in scalar_properties) {
      let value = scalar_properties[prop];
      if (typeof other[`min_${prop}`] !== "undefined" && other[`min_${prop}`] > value) return; // min_[prop]
      if (typeof other[`max_${prop}`] !== "undefined" && other[`max_${prop}`] < value) return; // max_[prop]
    }

    tile.others.push(other.name);
  }

  _add_element(element, tile, x, y) {
    let {
      temperature,
      humidity,
      height,
      slope: [slope_x, slope_y],
      grounds,
      others
    } = tile;

    let slope = Math.sqrt(slope_x ** 2 + slope_y ** 2);

    const scalar_properties = {
      slope,
      height,
      humidity,
      temperature
    }

    for (let prop in scalar_properties) { // the usual
      let value = scalar_properties[prop];
      if (typeof element[`min_${prop}`] !== "undefined" && element[`min_${prop}`] > value) return; // min_[prop]
      if (typeof element[`max_${prop}`] !== "undefined" && element[`max_${prop}`] < value) return; // max_[prop]
    }

    let prob = 0;

    element.conditions.forEach(condition => { // condition handler
      for (let prop in scalar_properties) { // again, the usual
        let value = scalar_properties[prop];
        if (typeof condition[`min_${prop}`] !== "undefined" && condition[`min_${prop}`] > value) return; // min_[prop]
        if (typeof condition[`max_${prop}`] !== "undefined" && condition[`max_${prop}`] < value) return; // max_[prop]
      }

      let _prob = condition.probability || 0;

      if (condition.grounds) {
        for (let name in condition.grounds) {
          /* Ground condition format:
            [min_amount, amount_prob_change]
            [-max_amount, amount_prob_change]
          */
          let ground = condition.grounds[name];
          let _ground = grounds.find(g => g.name == name); // tile's ground
          if (!_ground) return; // ground not found, condition violated
          if (ground[0] > 0 && _ground.amount < ground[0]) return;
          if (ground[0] < 0 && _ground.amount > -ground[0]) return;
          if (ground[1]) _prob += ground[1] * _ground.amount;
        }
      }

      if (condition.others) {
        if (!condition.others.every(other => {
          return tile.others.includes(other);
        })) {
          return;
        }
      }
      prob += _prob; // success
    });



    if (prob < 0) return;

    let simplex = new Simplex(String(this.settings.seed) + "/element:" + element.name);

    let _prob = simplex.noise2D(
      x * this.settings.scale * (element.noise_scale || 1),
      y * this.settings.scale * (element.noise_scale || 1)
    ) / 2 + .5; // probability to test

    if (prob > _prob) { // add element
      tile.elements.push({
        name: element.name,
        amount: _prob / prob
      });
    }
  }
}


const aww = function aww(n, callback) {
  return Array.apply(null, Array(n)).map((_, i) => callback(i));
}

const sum = function sum(start_value, n, callback) {
  let s = 0, x;
  for (x = start_value; x <= n; x++) {
    s += callback(x);
  }
  return s;
}

const gblur = function gblur(map, x, y, amount, radius, prop = null) {
  let w = map.length;
  let h = (map[0] || []).length;
  let s = 0, ws = 0;
  for (let _x = Math.max(x - radius, 0); _x < Math.min(x + radius, w - 1); _x++) {
    for (let _y = Math.max(y - radius, 0); _y < Math.min(y + radius, h - 1); _y++) {
      let dx = x - _x;
      let dy = y - _y;
      let w = Math.pow(Math.E, -(dx ** 2 + dy ** 2));
      if (prop) s += ((map[x] || [])[_y] || {})[prop] * w;
      else s += ((map[x] || [])[_y] || 0) * w;
      ws += w;
    }
  }
  return s / ws * amount + map[x][y] * (1 - amount);
}

const through = function through(map, callback) {
  for (let x = 0; x < map.length; x++) {
    for (let y = 0; y < map[x].length; y++) {
      callback.call(map[x][y], map[x][y], x, y);
    }
  }
}

const sigma = function sigma(x) {
  return x / (Math.abs(x) + 1);
}

const get_slope = function get_slope(map, x, y) {
  let x1, x2, y1, y2;

  if (x > 0) {
    x1 = map[x-1][y];
  } else {
    x1 = map[x][y];
  }

  if (x < map.length - 1) {
    x2 = map[x+1][y];
  } else {
    x2 = map[x][y];
  }

  if (y > 0) {
    y1 = map[x][y-1];
  } else {
    y1 = map[x][y];
  }

  if (y < map[x].length - 1) {
    y2 = map[x][y+1];
  } else {
    y2 = map[x][y];
  }
  //console.log(x1, x2, y1, y2);
  return [x2.height - x1.height, y2.height - y1.height];
}
