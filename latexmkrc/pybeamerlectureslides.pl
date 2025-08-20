use File::Basename;
use Cwd 'abs_path';
my $latexmkrcdir = dirname(abs_path(__FILE__));

# --- pybeamerlectureslides uses beamerthemeunicatt ---
do "$latexmkrcdir/beamerthemeunicatt.pl" or die "Can't load beamerthemeunicatt.pl: $!";
