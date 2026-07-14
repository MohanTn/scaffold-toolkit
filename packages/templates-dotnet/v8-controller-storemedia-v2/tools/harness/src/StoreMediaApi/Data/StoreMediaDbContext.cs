using Microsoft.EntityFrameworkCore;

namespace StoreMediaApi.Data;

public class StoreMediaDbContext : DbContext
{
    public StoreMediaDbContext(DbContextOptions<StoreMediaDbContext> options)
        : base(options)
    {
    }

    // SCAFFOLD:V2_DBSETS:START
    // SCAFFOLD:V2_DBSETS:END

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(StoreMediaDbContext).Assembly);
        base.OnModelCreating(modelBuilder);
    }
}
